// Small private groups (up to 50) with no server (plan §8.6, Phase 2).
//
// Group record  {v, id, name, createdBy, admins[], members[{p2pId, identityKey, name}], epoch, prev, ts, by, sig}
//   Signed (Ed25519) by an admin of the PREVIOUS record (`by`); epoch + 1 and `prev` = hash of the previous
//   record on every change (add / remove / rename / admin change). A record from a non-admin, a changed
//   record, or one that does not follow the chain is refused.
//   Genesis (epoch 0): signed by `createdBy`, `prev` = a random 16-byte nonce, and the group id is the
//   hash of that genesis (genesisId), so nobody else can make a "first record" for an existing id.
//   A newcomer gets the genesis with the invite and checks the whole chain up to the current record
//   (g-sync / g-rec) before the invite is shown (security review M-5).
//   Two admins changing at once (same epoch): everyone keeps the same one by forkWins(), an order the
//   signer can't grind: a record that removes or demotes the other record's signer wins over it; then
//   one that removes someone; then the more senior signer (the creator, then admin for longer); the
//   hash only between two records of the same signer (security review H-2).
//
// Sender keys  Each member makes a random 32-byte key for each epoch and sends it to every other member,
//   sealed to that member's identity key (X25519 → HKDF → AES-256-GCM) and signed by the owner. Sealed,
//   so other members may carry it to someone the owner can't reach. A new epoch (any change) means new
//   keys from everyone, so a removed member can't read anything after the removal and a new member
//   can't read anything from before.
//
// Messages     {k:'g-msg', gid, epoch, mid, from, ts, ct, sig, hop, want}
//   ct = iv || AES-256-GCM(sender key of `from` for `epoch`, aad = JSON["p2ptalk-gmsg-v1", gid, epoch, from, mid]).
//   sig = Ed25519 by `from` over (gid, epoch, mid, from, ts, ct), so members can't fake each other.
//   Fan-out: the sender sends to every member it can reach; `want` lists those it couldn't, and the
//   receivers pass it on (hop + 1, at most 2 hops) or keep it until that member connects (inventory /
//   request, so one copy usually arrives). Duplicates are dropped by mid.
//   Kept until delivered (BUG-6): the sender and every carrier keep each frame for every member it was
//   meant for until that member says it has it (g-ack), also when it was "sent" over a connection that
//   looked open (a member who just closed the app). On every (re)connection, and on every g-sync,
//   kept frames are offered (g-inv); kept frames and the ids already read survive a restart
//   (exportState). Bounded: 7 days, 500 per group.
//
// Everything travels over the existing LOCKED 1:1 channels between members (attach()), or, for
// keys / records / invites to someone offline, as a stored locked note on the relays (storeNote).

import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { concat, fromB64url, fromUtf8, toB64url, utf8 } from '../core/bytes';
import type { Channel, Frame } from '../core/channel';
import { idIsValid, p2pId, sign, verify, x25519PublicFromEd, x25519SecretFromEd } from '../core/identity';

export const MAX_MEMBERS = 50;
export const MAX_HOPS = 2;
export const GROUP_FEATURE = 'groups1';
/** Frame kinds this module handles (route these from the locked chat channel to GroupManager). */
export const GROUP_KINDS = new Set(['g-rec', 'g-invite', 'g-key', 'g-msg', 'g-leave', 'g-sync', 'g-inv', 'g-req', 'g-ack']);

const HISTORY = 64; // records taken from one g-rec frame
/** Records kept (from the genesis), so a newcomer can check the whole chain. */
const KEEP_RECORDS = 1000;
const MAX_TEXT = 60_000;
/** An old-epoch message may be dated at most this much after the record that ended its epoch (clocks). */
export const OLD_EPOCH_SKEW_MS = 120_000;
/** Invites still being checked (chain from the genesis): how many at once, and for how long. */
const MAX_JOINING = 20;
const JOINING_MS = 10 * 60_000;
/** Frames waiting for a record or key, per sender (L-5). */
const PER_SENDER_QUEUED = 100;
/** Ids of frames already read, kept across a restart (so a frame offered again is not shown twice). */
const SEEN_SAVED = 5000;
/** Members the app is asked to connect to at once, for one message (the rest get it from them). */
const CONNECT_AT_ONCE = 8;
/** Acks wait this long, so several go out in one frame. */
const ACK_DELAY_MS = 50;

export interface GroupMember {
  p2pId: string;
  /** Ed25519 identity public key, base64url. */
  identityKey: string;
  name: string;
}

export interface GroupRecord {
  v: 1;
  id: string;
  name: string;
  createdBy: string;
  admins: string[];
  members: GroupMember[];
  epoch: number;
  /** Hash of the previous record ('' at epoch 0). */
  prev: string;
  ts: number;
  /** The admin who signed this record. */
  by: string;
  sig: string;
  /** The group picture: lowercase hex SHA-256 of its bytes (never the bytes). Absent: no picture. */
  pic?: string;
}

/** A group picture hash as it may appear in a record. */
export const isPicHash = (h: unknown): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);

export type GroupFrame =
  | { k: 'g-rec'; gid: string; recs: GroupRecord[] }
  /** `gen`: the genesis record (binds `gid`); the newcomer asks for the records in between with g-sync. */
  | { k: 'g-invite'; gid: string; rec: GroupRecord; gen?: GroupRecord }
  | { k: 'g-key'; gid: string; epoch: number; rh: string; owner: string; to: string; eph: string; ct: string; sig: string; hop?: number; want?: string[] }
  | { k: 'g-msg'; gid: string; epoch: number; mid: string; from: string; ts: number; ct: string; sig: string; hop?: number; want?: string[] }
  | { k: 'g-leave'; gid: string; from: string; epoch: number; ts: number; sig: string }
  | { k: 'g-sync'; gid: string; epoch: number; rh: string }
  | { k: 'g-inv'; ids: string[] }
  /** `ack: 1`: I send g-ack for what I get (newer builds); without it, a request counts as delivered. */
  | { k: 'g-req'; ids: string[]; ack?: 1 }
  /** "I have these" (read, or already had them): the holder stops keeping them for me. */
  | { k: 'g-ack'; ids: string[] };

type MsgFrame = Extract<GroupFrame, { k: 'g-msg' }>;
type KeyFrame = Extract<GroupFrame, { k: 'g-key' }>;

export type GroupStatus = 'invited' | 'joined' | 'removed' | 'left';

export interface GroupInfo {
  id: string;
  name: string;
  epoch: number;
  createdBy: string;
  admins: string[];
  members: GroupMember[];
  status: GroupStatus;
  iAmAdmin: boolean;
  /** The group picture's SHA-256 (hex), from the signed record; the bytes come from members (photos.ts). */
  pic?: string;
}

export interface GroupMessage {
  gid: string;
  mid: string;
  from: string;
  fromName: string;
  ts: number;
  body: unknown;
}

export interface GroupEvents {
  message(m: GroupMessage): void;
  /** A group was created, joined or changed. */
  group(g: GroupInfo): void;
  /** Someone added me: show Join / Leave. */
  invite(g: GroupInfo, by: string): void;
  /** I was removed from the group (or my leave went through). */
  removed(g: GroupInfo): void;
  /** Another admin's change at the same moment won; mine was dropped (do it again if still wanted). */
  conflict(g: GroupInfo, dropped: GroupRecord): void;
}

export interface Me {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  name: string;
}

export interface GroupOptions {
  /** Store a locked note for an offline member on the relays (keys, records, invites). Optional. */
  storeNote?: (p2pId: string, frame: GroupFrame) => Promise<void>;
  /**
   * Something waits for a member I'm not connected to: the app may connect to them now (a contact, or a
   * group-member link through the relays). Asked at most once a minute per member. Optional.
   */
  connect?: (p2pId: string) => void;
  /**
   * Messages for an older epoch are still read this long after it ended (here), only from senders who
   * are still members, and only if dated before the next record (+ OLD_EPOCH_SKEW_MS). Default 5 min.
   */
  oldEpochGraceMs?: number;
  /** How long frames are kept for members who are away. Default 7 days. */
  keepMs?: number;
  /** Most frames kept for others, all groups. Default 5000. */
  maxKept?: number;
  /** Most frames kept for others, per group (the oldest go first). Default 500. */
  maxKeptPerGroup?: number;
  /** How many direct receivers get the "pass it on" list. Default 4. */
  relayFanout?: number;
  /** An admin removes a member who sent a valid leave. Default true. */
  autoRemoveLeavers?: boolean;
  now?: () => number;
}

// ---- records ------------------------------------------------------------------------------------------

const byId = (a: GroupMember, b: GroupMember) => (a.p2pId < b.p2pId ? -1 : a.p2pId > b.p2pId ? 1 : 0);

/** The exact bytes an admin signs (a JSON array, so key order can't differ between apps). */
export function recordBytes(r: Omit<GroupRecord, 'sig'>): Uint8Array {
  return utf8(
    JSON.stringify([
      'p2ptalk-group-v1',
      r.id,
      r.name,
      r.createdBy,
      [...r.admins].sort(),
      [...r.members].sort(byId).map((m) => [m.p2pId, m.identityKey, m.name]),
      r.epoch,
      r.prev,
      r.ts,
      r.by,
      // Only when there is a picture, so records without one sign exactly as before.
      ...(r.pic !== undefined ? [r.pic] : []),
    ]),
  );
}

export const recordHash = (r: GroupRecord): string => toB64url(sha256(concat(recordBytes(r), fromB64url(r.sig))));

export function signRecord(me: Me, r: Omit<GroupRecord, 'sig' | 'by'>): GroupRecord {
  const unsigned = { ...r, by: p2pId(me.publicKey) };
  return { ...unsigned, sig: toB64url(sign(me.secretKey, recordBytes(unsigned))) };
}

const isStr = (s: unknown, max = 200): s is string => typeof s === 'string' && s.length <= max;

/** Shape and self-consistency of a record (not its authority: see checkNext / checkBase). */
export function recordShapeOk(r: GroupRecord): boolean {
  try {
    if (!r || r.v !== 1 || !isStr(r.id, 64) || !isStr(r.name, 64) || !isStr(r.createdBy, 24) || !isStr(r.prev, 64) || !isStr(r.by, 24) || !isStr(r.sig, 100))
      return false;
    if (!Number.isSafeInteger(r.epoch) || r.epoch < 0 || typeof r.ts !== 'number') return false;
    if (r.pic !== undefined && !isPicHash(r.pic)) return false;
    if (!Array.isArray(r.members) || !Array.isArray(r.admins) || r.members.length > MAX_MEMBERS || r.members.length < 1) return false;
    const ids = new Set<string>();
    for (const m of r.members) {
      if (!m || !isStr(m.p2pId, 24) || !isStr(m.identityKey, 64) || !isStr(m.name, 64) || ids.has(m.p2pId)) return false;
      const k = fromB64url(m.identityKey);
      if (k.length !== 32 || p2pId(k) !== m.p2pId) return false;
      ids.add(m.p2pId);
    }
    if (!r.admins.length || new Set(r.admins).size !== r.admins.length || !r.admins.every((a) => ids.has(a))) return false;
    return fromB64url(r.sig).length === 64;
  } catch {
    return false;
  }
}

const memberKey = (r: GroupRecord, id: string) => {
  const m = r.members.find((x) => x.p2pId === id);
  return m ? fromB64url(m.identityKey) : null;
};

/** `next` is a valid change of `prev`: right chain, signed by an admin of `prev`. */
export function checkNext(prev: GroupRecord, next: GroupRecord): boolean {
  if (!recordShapeOk(next) || next.id !== prev.id || next.createdBy !== prev.createdBy) return false;
  if (next.epoch !== prev.epoch + 1 || next.prev !== recordHash(prev)) return false;
  if (!prev.admins.includes(next.by)) return false;
  const key = memberKey(prev, next.by);
  return !!key && verify(key, recordBytes(next), fromB64url(next.sig));
}

/**
 * Self-signed by one of its own admins (shape and signature only). NOT enough to trust a group seen
 * for the first time: anyone can make such a record for any id (M-5). Use checkGenesis + the chain.
 */
export function checkBase(r: GroupRecord): boolean {
  if (!recordShapeOk(r) || !r.admins.includes(r.by)) return false;
  const key = memberKey(r, r.by);
  return !!key && verify(key, recordBytes(r), fromB64url(r.sig));
}

/**
 * The id of a group = hash of its genesis record (everything in it but `id`, `by` and `sig`, with the
 * creator's identity key), so only the creator can make a genesis for that id.
 */
export function genesisId(r: Omit<GroupRecord, 'id' | 'by' | 'sig'>): string {
  const creatorKey = r.members.find((m) => m.p2pId === r.createdBy)?.identityKey ?? '';
  const bytes = utf8(
    JSON.stringify([
      'p2ptalk-gid-v1',
      r.createdBy,
      creatorKey,
      r.name,
      [...r.admins].sort(),
      [...r.members].sort(byId).map((m) => [m.p2pId, m.identityKey, m.name]),
      r.epoch,
      r.prev,
      r.ts,
    ]),
  );
  return toB64url(sha256(bytes).subarray(0, 16));
}

/** A valid genesis: epoch 0, signed by its creator (an admin), and its id is genesisId() of it. */
export function checkGenesis(r: GroupRecord): boolean {
  if (!recordShapeOk(r) || r.epoch !== 0 || r.by !== r.createdBy || !r.admins.includes(r.createdBy) || r.prev.length < 16) return false;
  if (r.id !== genesisId(r)) return false;
  const key = memberKey(r, r.by);
  return !!key && verify(key, recordBytes(r), fromB64url(r.sig));
}

/** `parent` → `r` removes a member or takes away an admin role. */
const removesSomeone = (parent: GroupRecord, r: GroupRecord) =>
  parent.members.some((m) => !r.members.some((x) => x.p2pId === m.p2pId)) || parent.admins.some((a) => !r.admins.includes(a));

/**
 * Two valid records for the same epoch (both checkNext(parent, …)): does `a` win over `b`? The same
 * answer on every device, and nothing the signer can change by grinding `ts` (H-2):
 *   1. a record that removes or demotes the OTHER record's signer wins ("a removal can't be undone by
 *      the person removed"), unless both do that to each other;
 *   2. a record that removes someone (or takes an admin role) wins over one that doesn't;
 *   3. the more senior signer wins: the creator, then the one who has been admin since the earlier
 *      epoch (`adminSince`), then the lower P2P ID;
 *   4. only two records by the same signer are ordered by hash.
 */
export function forkWins(parent: GroupRecord, a: GroupRecord, b: GroupRecord, adminSince: (id: string) => number = () => parent.epoch): boolean {
  const aCutsB = !a.admins.includes(b.by);
  const bCutsA = !b.admins.includes(a.by);
  if (aCutsB !== bCutsA) return aCutsB;
  const aRem = removesSomeone(parent, a);
  const bRem = removesSomeone(parent, b);
  if (aRem !== bRem) return aRem;
  if (a.by !== b.by) {
    const rank = (id: string) => (id === parent.createdBy ? -1 : adminSince(id));
    if (rank(a.by) !== rank(b.by)) return rank(a.by) < rank(b.by);
    return a.by < b.by;
  }
  return recordHash(a) < recordHash(b);
}

// ---- sealing ----------------------------------------------------------------------------------------------

const aesKey = (raw: Uint8Array, use: KeyUsage[]) => crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, use);

async function gcmSeal(key: Uint8Array, ad: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad as BufferSource }, await aesKey(key, ['encrypt']), plain as BufferSource);
  return concat(iv, new Uint8Array(ct));
}

async function gcmOpen(key: Uint8Array, ad: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < 28) throw new Error('too short');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: blob.subarray(0, 12) as BufferSource, additionalData: ad as BufferSource },
    await aesKey(key, ['decrypt']),
    blob.subarray(12) as BufferSource,
  );
  return new Uint8Array(pt);
}

const msgAad = (gid: string, epoch: number, from: string, mid: string) => utf8(JSON.stringify(['p2ptalk-gmsg-v1', gid, epoch, from, mid]));
const msgSigBytes = (f: Pick<MsgFrame, 'gid' | 'epoch' | 'mid' | 'from' | 'ts' | 'ct'>) =>
  utf8(JSON.stringify(['p2ptalk-gmsg-v1', f.gid, f.epoch, f.mid, f.from, f.ts, f.ct]));
const keyLabel = (f: Pick<KeyFrame, 'gid' | 'epoch' | 'rh' | 'owner' | 'to'>) => JSON.stringify(['p2ptalk-gkey-v1', f.gid, f.epoch, f.rh, f.owner, f.to]);
const keySigBytes = (f: Omit<KeyFrame, 'k' | 'sig' | 'hop' | 'want'>) => utf8(JSON.stringify([keyLabel(f), f.eph, f.ct]));
const leaveBytes = (gid: string, from: string, epoch: number, ts: number) => utf8(JSON.stringify(['p2ptalk-gleave-v1', gid, from, epoch, ts]));

/** Locks a group message with a sender key (exported for tests). */
export async function sealGroupMessage(key: Uint8Array, gid: string, epoch: number, from: string, mid: string, body: unknown): Promise<string> {
  return toB64url(await gcmSeal(key, msgAad(gid, epoch, from, mid), utf8(JSON.stringify(body))));
}

/** Opens a group message ct with one sender key; throws if the key is wrong (exported for tests). */
export async function openGroupMessage(key: Uint8Array, f: Pick<MsgFrame, 'gid' | 'epoch' | 'from' | 'mid' | 'ct'>): Promise<unknown> {
  return JSON.parse(fromUtf8(await gcmOpen(key, msgAad(f.gid, f.epoch, f.from, f.mid), fromB64url(f.ct))));
}

async function sealKey(me: Me, myId: string, gid: string, epoch: number, rh: string, to: GroupMember, key: Uint8Array): Promise<KeyFrame> {
  const ephSecret = x25519.utils.randomPrivateKey();
  const eph = x25519.getPublicKey(ephSecret);
  const toX = x25519PublicFromEd(fromB64url(to.identityKey));
  const head = { gid, epoch, rh, owner: myId, to: to.p2pId };
  const kek = hkdf(sha256, x25519.getSharedSecret(ephSecret, toX), concat(eph, toX), utf8(keyLabel(head)), 32);
  const ct = toB64url(await gcmSeal(kek, utf8(keyLabel(head)), key));
  const body = { ...head, eph: toB64url(eph), ct };
  return { k: 'g-key', ...body, sig: toB64url(sign(me.secretKey, keySigBytes(body))) };
}

async function openKey(me: Me, f: KeyFrame): Promise<Uint8Array> {
  const eph = fromB64url(f.eph);
  if (eph.length !== 32) throw new Error('bad key');
  const myX = x25519.getPublicKey(x25519SecretFromEd(me.secretKey));
  const shared = x25519.getSharedSecret(x25519SecretFromEd(me.secretKey), eph);
  if (shared.every((b) => b === 0)) throw new Error('bad key');
  const kek = hkdf(sha256, shared, concat(eph, myX), utf8(keyLabel(f)), 32);
  const key = await gcmOpen(kek, utf8(keyLabel(f)), fromB64url(f.ct));
  if (key.length !== 32) throw new Error('bad key');
  return key;
}

const randomId = (n = 9) => toB64url(crypto.getRandomValues(new Uint8Array(n)));

// ---- the manager ---------------------------------------------------------------------------------------

interface Group {
  rec: GroupRecord;
  rh: string;
  status: GroupStatus;
  history: Map<number, { rec: GroupRecord; rh: string }>;
  pendingRecs: Map<number, GroupRecord[]>;
  /** `${epoch}|${owner}` -> keys (more than one only after two admins changed at once). */
  keys: Map<string, Uint8Array[]>;
  myKeys: Map<number, { rh: string; key: Uint8Array }>;
  epochEnded: Map<number, number>;
  invitedBy?: string;
  /** The genesis record (binds the id); null for groups made before ids were bound (no new members). */
  gen: GroupRecord | null;
}

/** An invite whose chain (genesis → the invite's record) is still being checked. */
interface Joining {
  gen: GroupRecord;
  chain: GroupRecord[];
  target: GroupRecord;
  from: string;
  at: number;
}

interface Kept {
  frame: MsgFrame | KeyFrame;
  gid: string;
  targets: Set<string>;
  expires: number;
}

/**
 * Groups for one identity. attach() every locked 1:1 channel (contacts and group members); route
 * received group frames with it (attach subscribes to channel.onFrame) or call onFrame() directly.
 */
export class GroupManager {
  readonly myId: string;
  private readonly o: Required<Omit<GroupOptions, 'storeNote' | 'connect'>> & Pick<GroupOptions, 'storeNote' | 'connect'>;
  /** When I last asked the app to connect to each member. */
  private readonly asked = new Map<string, number>();
  private readonly groups = new Map<string, Group>();
  private readonly joining = new Map<string, Joining>();
  private readonly channels = new Map<string, Channel>();
  private readonly outbox = new Map<string, GroupFrame[]>();
  private readonly kept = new Map<string, Kept>();
  private readonly seen = new Map<string, number>(); // processed message / key ids (dedupe)
  private readonly relayed = new Set<string>();
  private readonly requested = new Map<string, number>();
  /** "I don't have this group" asked, by member and group (once a minute). */
  private readonly missingAsked = new Map<string, number>();
  /** Members on older builds (their g-req has no `ack`): they never send g-ack. */
  private readonly legacy = new Set<string>();
  private pendingMsgs: { f: MsgFrame; at: number; via?: string }[] = [];
  /** Acks waiting to go out, by the member they go to. */
  private readonly acks = new Map<string, Set<string>>();
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingKeys: { f: KeyFrame; at: number }[] = [];
  private readonly listeners = new Map<keyof GroupEvents, Set<(...a: never[]) => void>>();
  private work: Promise<void> = Promise.resolve();

  constructor(
    private readonly me: Me,
    opts: GroupOptions = {},
  ) {
    this.myId = p2pId(me.publicKey);
    this.o = {
      oldEpochGraceMs: 5 * 60_000,
      keepMs: 7 * 24 * 3600_000,
      maxKept: 5000,
      maxKeptPerGroup: 500,
      relayFanout: 4,
      autoRemoveLeavers: true,
      now: () => Date.now(),
      ...opts,
    };
  }

  on<K extends keyof GroupEvents>(k: K, fn: GroupEvents[K]): () => void {
    const set = this.listeners.get(k) ?? new Set();
    set.add(fn as (...a: never[]) => void);
    this.listeners.set(k, set);
    return () => set.delete(fn as (...a: never[]) => void);
  }

  private emit<K extends keyof GroupEvents>(k: K, ...a: Parameters<GroupEvents[K]>): void {
    for (const fn of [...(this.listeners.get(k) ?? [])]) (fn as (...x: unknown[]) => void)(...a);
  }

  /** Resolves when every frame received so far has been handled (tests, and before saving state). */
  idle(): Promise<void> {
    return this.work;
  }

  /** Received frames and user actions run one at a time, in order. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.work.then(fn);
    this.work = p.then(
      () => undefined,
      () => undefined, // the caller gets the error
    );
    return p;
  }

  // ---- channels ----------------------------------------------------------------------------------------

  /** A locked 1:1 channel with a contact / member is up. Returns detach (call it when it drops). */
  attach(ch: Channel): () => void {
    const peer = ch.peerId;
    this.channels.set(peer, ch);
    const unsub = ch.onFrame((f) => this.onFrame(peer, f));
    // Things that waited for this person.
    const queued = this.outbox.get(peer) ?? [];
    this.outbox.delete(peer);
    for (const f of queued) this.direct(peer, f);
    this.greet(peer);
    return () => {
      unsub();
      if (this.channels.get(peer) === ch) this.channels.delete(peer);
    };
  }

  /**
   * What happens on every (re)connection with a member: for each shared group, g-sync (records, and
   * their sender key comes back) and my current sender key; the rest of the chain for invites still
   * being checked; and the inventory of frames I keep for them (BUG-6).
   */
  private greet(peer: string): void {
    for (const [gid, g] of this.groups) {
      if (g.status !== 'joined' || !this.isMember(g.rec, peer)) continue;
      this.direct(peer, { k: 'g-sync', gid, epoch: g.rec.epoch, rh: g.rh });
      void this.sendMyKeyTo(g, peer);
    }
    // Invites still being checked: ask this member for the rest of the chain.
    for (const [gid, j] of this.joining) {
      if (j.from === peer || this.isMember(j.target, peer)) {
        const cur = j.chain[j.chain.length - 1];
        this.direct(peer, { k: 'g-sync', gid, epoch: cur.epoch, rh: recordHash(cur) });
      }
    }
    this.offerKept(peer);
  }

  /** Every group frame from `from` (the P2P ID of the 1:1 channel it came on). Other kinds are ignored. */
  onFrame(from: string, f: Frame): void {
    const w = f as GroupFrame;
    if (!w || typeof w !== 'object' || !GROUP_KINDS.has((w as { k: string }).k)) return;
    this.run(() => this.handle(from, w)).catch((e) => console.warn('P2P Talk: group frame', e));
  }

  /** Can I reach this person right now? */
  private reachable(id: string): boolean {
    return this.channels.has(id);
  }

  private direct(to: string, f: GroupFrame): boolean {
    const ch = this.channels.get(to);
    if (!ch) return false;
    ch.send(f).catch(() => undefined);
    return true;
  }

  /** Asks the app to connect to members something waits for (at most CONNECT_AT_ONCE, once a minute each). */
  private wantConnect(ids: string[]): void {
    if (!this.o.connect) return;
    const now = this.o.now();
    let n = 0;
    for (const id of ids) {
      if (n >= CONNECT_AT_ONCE) break;
      if (id === this.myId || this.reachable(id) || now - (this.asked.get(id) ?? -Infinity) < 60_000) continue;
      this.asked.set(id, now);
      n++;
      try {
        this.o.connect(id);
      } catch {
        /* the app's problem */
      }
    }
  }

  /** Direct if connected, else wait in the outbox (+ a stored note on the relays when available). */
  private deliver(to: string, f: GroupFrame): void {
    if (to === this.myId || this.direct(to, f)) return;
    this.wantConnect([to]);
    const box = this.outbox.get(to) ?? [];
    box.push(f);
    if (box.length > 500) box.shift();
    this.outbox.set(to, box);
    void this.o.storeNote?.(to, f).catch(() => undefined);
  }

  // ---- reading state ---------------------------------------------------------------------------------

  list(): GroupInfo[] {
    return [...this.groups.values()].map((g) => this.info(g));
  }

  get(gid: string): GroupInfo | undefined {
    const g = this.groups.get(gid);
    return g && this.info(g);
  }

  /** The current signed record (for tests and for showing "changed by"). */
  record(gid: string): GroupRecord | undefined {
    return this.groups.get(gid)?.rec;
  }

  private info(g: Group): GroupInfo {
    return {
      id: g.rec.id,
      name: g.rec.name,
      epoch: g.rec.epoch,
      createdBy: g.rec.createdBy,
      admins: [...g.rec.admins],
      members: g.rec.members.map((m) => ({ ...m })),
      status: g.status,
      iAmAdmin: g.rec.admins.includes(this.myId),
      ...(g.rec.pic ? { pic: g.rec.pic } : {}),
    };
  }

  private isMember(r: GroupRecord, id: string): boolean {
    return r.members.some((m) => m.p2pId === id);
  }

  private recAt(g: Group, epoch: number): { rec: GroupRecord; rh: string } | undefined {
    return epoch === g.rec.epoch ? { rec: g.rec, rh: g.rh } : g.history.get(epoch);
  }

  /** A member now, or in the epoch just before (frames sent around a change still count). */
  private knownPeer(g: Group, id: string): boolean {
    return this.isMember(g.rec, id) || !!g.history.get(g.rec.epoch - 1)?.rec.members.some((m) => m.p2pId === id);
  }

  // ---- admin actions -----------------------------------------------------------------------------------

  private meAsMember(): GroupMember {
    return { p2pId: this.myId, identityKey: toB64url(this.me.publicKey), name: this.me.name.slice(0, 64) };
  }

  /** New group with me as admin. `members`: contacts (P2P ID, identity key, name). */
  create(name: string, members: GroupMember[]): Promise<string> {
    return this.run(() => this.createNow(name, members));
  }

  private async createNow(name: string, members: GroupMember[]): Promise<string> {
    const list = this.uniqueMembers([this.meAsMember(), ...members]);
    const base = {
      v: 1 as const,
      name: name.trim().slice(0, 64) || 'Group',
      createdBy: this.myId,
      admins: [this.myId],
      members: list,
      epoch: 0,
      prev: randomId(16), // the genesis nonce
      ts: this.o.now(),
    };
    const rec = signRecord(this.me, { ...base, id: genesisId(base) });
    if (!checkGenesis(rec)) throw new Error('bad group');
    const g = this.newGroup(rec, 'joined');
    g.gen = rec;
    this.groups.set(rec.id, g);
    for (const m of rec.members) if (m.p2pId !== this.myId) this.deliver(m.p2pId, { k: 'g-invite', gid: rec.id, rec, gen: rec });
    await this.rotate(g);
    this.emit('group', this.info(g));
    return rec.id;
  }

  addMembers(gid: string, members: GroupMember[]): Promise<void> {
    return this.change(gid, (r) => ({ ...r, members: this.uniqueMembers([...r.members, ...members]) }));
  }

  removeMembers(gid: string, ids: string[]): Promise<void> {
    return this.change(gid, (r) => this.withoutMembers(r, ids));
  }

  rename(gid: string, name: string): Promise<void> {
    return this.change(gid, (r) => ({ ...r, name: name.trim().slice(0, 64) || r.name }));
  }

  /** Admins: set the group picture (its SHA-256, lowercase hex) or remove it (null). Signed like a rename. */
  async setPicture(gid: string, hash: string | null): Promise<void> {
    if (hash !== null && !isPicHash(hash)) throw new Error('Not a picture hash.');
    return this.change(gid, (r) => {
      const { pic: _old, ...rest } = r;
      void _old;
      return hash ? { ...rest, pic: hash } : rest;
    });
  }

  setAdmin(gid: string, id: string, admin: boolean): Promise<void> {
    return this.change(gid, (r) => {
      if (!this.isMember(r, id)) throw new Error('not a member');
      const admins = admin ? [...new Set([...r.admins, id])] : r.admins.filter((a) => a !== id);
      if (!admins.length) throw new Error('A group needs at least one admin.');
      return { ...r, admins };
    });
  }

  private uniqueMembers(list: GroupMember[]): GroupMember[] {
    const out = new Map<string, GroupMember>();
    for (const m of list) {
      const key = fromB64url(m.identityKey);
      if (key.length !== 32 || p2pId(key) !== m.p2pId || !idIsValid(m.p2pId)) throw new Error('A member has a wrong key.');
      if (!out.has(m.p2pId)) out.set(m.p2pId, { p2pId: m.p2pId, identityKey: m.identityKey, name: String(m.name).slice(0, 64) });
    }
    if (out.size > MAX_MEMBERS) throw new Error(`Groups have up to ${MAX_MEMBERS} people.`);
    return [...out.values()];
  }

  private withoutMembers(r: GroupRecord, ids: string[]): GroupRecord {
    const members = r.members.filter((m) => !ids.includes(m.p2pId));
    if (!members.length) throw new Error('A group needs at least one member.');
    let admins = r.admins.filter((a) => !ids.includes(a));
    if (!admins.length) admins = [[...members].sort(byId)[0].p2pId]; // never leave a group without an admin
    return { ...r, members, admins };
  }

  private change(gid: string, edit: (r: GroupRecord) => GroupRecord): Promise<void> {
    return this.run(() => this.changeNow(gid, edit));
  }

  /** Makes, signs and sends the next record. Only admins. */
  private async changeNow(gid: string, edit: (r: GroupRecord) => GroupRecord): Promise<void> {
    const g = this.groups.get(gid);
    if (!g || g.status !== 'joined') throw new Error('Not in this group.');
    if (!g.rec.admins.includes(this.myId)) throw new Error('Only admins can change the group.');
    const e = edit(g.rec);
    const next = signRecord(this.me, {
      v: 1,
      id: e.id,
      name: e.name,
      createdBy: e.createdBy,
      admins: e.admins,
      members: e.members,
      epoch: g.rec.epoch + 1,
      prev: g.rh,
      ts: this.o.now(),
      ...(e.pic ? { pic: e.pic } : {}),
    });
    if (!checkNext(g.rec, next)) throw new Error('bad change');
    const before = g.rec;
    await this.applyNext(g, next, false);
    this.announce(next, before);
    if (g.status === 'joined') await this.rotate(g);
  }

  /** Sends a new record: g-rec to members who had the group, g-invite to new members, g-rec to removed ones. */
  private announce(next: GroupRecord, before: GroupRecord, except?: string): void {
    const old = new Set(before.members.map((m) => m.p2pId));
    for (const m of next.members) {
      if (m.p2pId === this.myId || m.p2pId === except) continue;
      if (old.has(m.p2pId)) this.deliver(m.p2pId, { k: 'g-rec', gid: next.id, recs: [next] });
      else this.deliver(m.p2pId, this.inviteFrame(next));
    }
    for (const id of old) {
      if (id !== this.myId && id !== except && !this.isMember(next, id)) this.deliver(id, { k: 'g-rec', gid: next.id, recs: [next] });
    }
  }

  // ---- member actions -----------------------------------------------------------------------------------

  /** Join a group I was added to. */
  acceptInvite(gid: string): Promise<void> {
    return this.run(async () => {
      const g = this.groups.get(gid);
      if (!g || g.status !== 'invited') return;
      g.status = 'joined';
      await this.rotate(g);
      for (const m of g.rec.members) if (m.p2pId !== this.myId) this.direct(m.p2pId, { k: 'g-sync', gid, epoch: g.rec.epoch, rh: g.rh });
      this.emit('group', this.info(g));
      await this.retryPending();
    });
  }

  /** Say no to an invite (the admins are asked to remove me). */
  declineInvite(gid: string): Promise<void> {
    return this.run(async () => {
      if (this.groups.get(gid)?.status === 'invited') await this.leaveNow(gid);
    });
  }

  /** Leave: everyone is told (signed); an admin makes the removal record. If I am an admin, I make it. */
  leave(gid: string): Promise<void> {
    return this.run(() => this.leaveNow(gid));
  }

  private async leaveNow(gid: string): Promise<void> {
    const g = this.groups.get(gid);
    if (!g || g.status === 'left' || g.status === 'removed') return;
    if (g.status === 'joined' && g.rec.admins.includes(this.myId) && g.rec.members.length > 1) {
      await this.changeNow(gid, (r) => this.withoutMembers(r, [this.myId])); // emits 'removed'
      g.status = 'left';
      return;
    } else {
      const ts = this.o.now();
      const f: GroupFrame = {
        k: 'g-leave',
        gid,
        from: this.myId,
        epoch: g.rec.epoch,
        ts,
        sig: toB64url(sign(this.me.secretKey, leaveBytes(gid, this.myId, g.rec.epoch, ts))),
      };
      for (const m of g.rec.members) if (m.p2pId !== this.myId) this.deliver(m.p2pId, f);
    }
    g.status = 'left';
    g.keys.clear();
    g.myKeys.clear();
    this.emit('removed', this.info(g));
  }

  /**
   * "Delete group" (after leaving, or after being removed): the group's record and keys are forgotten
   * on this device, and nothing kept for its members is passed on any more. Only a group I am no longer
   * in can be forgotten. If an admin adds me again later, it comes back as a new invite (Join / Decline).
   */
  forget(gid: string): Promise<boolean> {
    return this.run(async () => {
      const g = this.groups.get(gid);
      if (!g || (g.status !== 'left' && g.status !== 'removed')) return false;
      this.groups.delete(gid);
      for (const [id, k] of this.kept) if (k.gid === gid) this.kept.delete(id);
      return true;
    });
  }

  // ---- sending -------------------------------------------------------------------------------------------

  /** Sends a message (any JSON value, e.g. {text}) to the group. */
  send(gid: string, body: unknown): Promise<{ mid: string; ts: number; direct: number; waiting: number }> {
    return this.run(() => this.sendNow(gid, body));
  }

  private async sendNow(gid: string, body: unknown): Promise<{ mid: string; ts: number; direct: number; waiting: number }> {
    const g = this.groups.get(gid);
    if (!g || g.status !== 'joined') throw new Error('Not in this group.');
    const mine = g.myKeys.get(g.rec.epoch);
    if (!mine) throw new Error('No key yet.');
    const text = JSON.stringify(body);
    if (text === undefined || text.length > MAX_TEXT) throw new Error('Message too long.');
    const mid = randomId();
    const ts = this.o.now();
    const head = { gid, epoch: g.rec.epoch, mid, from: this.myId, ts, ct: await sealGroupMessage(mine.key, gid, g.rec.epoch, this.myId, mid, body) };
    const frame: MsgFrame = { k: 'g-msg', ...head, sig: toB64url(sign(this.me.secretKey, msgSigBytes(head))), hop: 0, want: [] };
    this.markSeen(mid);
    this.markRelayed(mid);
    const others = g.rec.members.map((m) => m.p2pId).filter((id) => id !== this.myId);
    const near = others.filter((id) => this.reachable(id));
    const far = others.filter((id) => !this.reachable(id));
    near.forEach((id, i) => this.direct(id, { ...frame, want: i < this.o.relayFanout ? far : [] }));
    // Kept for everyone until they say they have it: a connection that looks open may already be dead.
    this.keep(frame, gid, others);
    // Members nobody can reach right now: connect to a few (contacts or group-member links); the
    // frame waits for them, and those who get it pass it on.
    this.wantConnect(far);
    return { mid, ts, direct: near.length, waiting: far.length };
  }

  // ---- receiving ------------------------------------------------------------------------------------------

  private async handle(from: string, w: GroupFrame): Promise<void> {
    switch (w.k) {
      case 'g-invite':
        return this.onInvite(from, w);
      case 'g-rec':
        return this.onRecords(from, w.gid, w.recs);
      case 'g-key':
        return this.onKey(from, w);
      case 'g-msg':
        return this.onMsg(from, w);
      case 'g-leave':
        return this.onLeave(from, w);
      case 'g-sync':
        return this.onSync(from, w);
      case 'g-inv':
        return this.onInv(from, w.ids);
      case 'g-req':
        return this.onReq(from, w.ids, w.ack === 1);
      case 'g-ack':
        return this.onAck(from, w.ids);
    }
  }

  private async onInvite(from: string, w: Extract<GroupFrame, { k: 'g-invite' }>): Promise<void> {
    const rec = w.rec;
    if (!rec || rec.id !== w.gid) return;
    const g = this.groups.get(rec.id);
    if (g) return this.onRecords(from, rec.id, [rec]); // already known: just a newer record
    // First sight of a group: it comes from a contact over our locked channel, both of us are in it,
    // and the id is bound to a genesis signed by the creator (M-5). A record past the genesis is only
    // believed once the chain from the genesis up to it checks (asked for with g-sync).
    const gen = w.gen;
    if (!gen || gen.id !== w.gid || !checkGenesis(gen)) return;
    if (!recordShapeOk(rec) || !this.isMember(rec, this.myId) || !this.isMember(rec, from)) return;
    if (rec.epoch === 0) {
      if (recordHash(rec) !== recordHash(gen)) return;
      return this.joined(gen, [gen], from);
    }
    const now = this.o.now();
    for (const [id, j] of this.joining) if (now - j.at > JOINING_MS) this.joining.delete(id);
    const known = this.joining.get(rec.id);
    if (known) {
      if (rec.epoch > known.target.epoch) known.target = rec;
    } else {
      if (this.joining.size >= MAX_JOINING) return;
      this.joining.set(rec.id, { gen, chain: [gen], target: rec, from, at: now });
    }
    const j = this.joining.get(rec.id)!;
    const cur = j.chain[j.chain.length - 1];
    this.direct(from, { k: 'g-sync', gid: rec.id, epoch: cur.epoch, rh: recordHash(cur) });
  }

  /** Records for an invite still being checked: extend the chain; once it reaches the invite, join. */
  private async onJoiningRecords(from: string, j: Joining, recs: GroupRecord[]): Promise<void> {
    for (const r of recs.slice(0, HISTORY).sort((a, b) => a.epoch - b.epoch)) {
      const cur = j.chain[j.chain.length - 1];
      if (!r || r.epoch !== cur.epoch + 1 || !checkNext(cur, r)) continue;
      j.chain.push(r);
      if (j.chain.length > KEEP_RECORDS + 1) return void this.joining.delete(j.gen.id);
    }
    const cur = j.chain[j.chain.length - 1];
    if (cur.epoch < j.target.epoch) return;
    this.joining.delete(j.gen.id);
    if (!this.isMember(cur, this.myId)) return; // removed again meanwhile
    await this.joined(j.gen, j.chain, this.isMember(cur, j.from) ? j.from : from);
  }

  /** A checked chain (genesis first): the group is shown as an invite. */
  private async joined(gen: GroupRecord, chain: GroupRecord[], from: string): Promise<void> {
    const cur = chain[chain.length - 1];
    const ng = this.newGroup(cur, 'invited');
    ng.gen = gen;
    for (const r of chain.slice(0, -1)) ng.history.set(r.epoch, { rec: r, rh: recordHash(r) });
    ng.invitedBy = from;
    this.groups.set(cur.id, ng);
    this.emit('invite', this.info(ng), from);
    await this.retryPending();
  }

  private async onRecords(from: string, gid: string, recs: GroupRecord[]): Promise<void> {
    const j = this.joining.get(gid);
    if (j && !this.groups.has(gid) && Array.isArray(recs)) return this.onJoiningRecords(from, j, recs);
    const g = this.groups.get(gid);
    if (!g || !Array.isArray(recs) || !this.knownPeer(g, from)) return;
    for (const r of recs.slice(0, HISTORY).sort((a, b) => a.epoch - b.epoch)) {
      if (!r || r.id !== gid || !Number.isSafeInteger(r.epoch)) continue;
      const before = g.rec;
      if (r.epoch === g.rec.epoch + 1) {
        if (!checkNext(g.rec, r)) continue;
        await this.applyNext(g, r, false);
        this.forward(r, before, from);
        if (g.status === 'joined') await this.rotate(g);
        await this.applyPendingRecs(g, from);
      } else if (r.epoch > g.rec.epoch + 1) {
        const list = g.pendingRecs.get(r.epoch) ?? [];
        if (list.length < 4) list.push(r);
        g.pendingRecs.set(r.epoch, list);
        this.direct(from, { k: 'g-sync', gid, epoch: g.rec.epoch, rh: g.rh }); // send me what I missed
      } else if (r.epoch === g.rec.epoch && r.epoch > 0 && recordHash(r) !== g.rh) {
        await this.onFork(g, r);
      }
    }
    await this.retryPending();
  }

  /** Two admins changed the group at the same time: everyone keeps the same record (forkWins). */
  private async onFork(g: Group, r: GroupRecord): Promise<void> {
    const parent = g.history.get(r.epoch - 1);
    if (!parent || !checkNext(parent.rec, r)) return;
    const rh = recordHash(r);
    if (!forkWins(parent.rec, r, g.rec, (id) => this.adminSince(g, parent.rec, id))) return; // mine wins; they switch when they see mine
    const dropped = g.rec;
    const wasMine = dropped.by === this.myId;
    g.rec = r;
    g.rh = rh;
    this.afterRecord(g);
    if (g.status === 'joined') await this.rotate(g);
    for (const m of r.members) if (m.p2pId !== this.myId) this.direct(m.p2pId, { k: 'g-rec', gid: r.id, recs: [r] });
    if (wasMine) this.emit('conflict', this.info(g), dropped);
    this.emit('group', this.info(g));
  }

  /** The first epoch from which `id` was an admin in every record up to `parent` (lower = more senior). */
  private adminSince(g: Group, parent: GroupRecord, id: string): number {
    let since = parent.epoch + 1;
    let r: GroupRecord | undefined = parent;
    while (r && r.admins.includes(id)) {
      since = r.epoch;
      r = r.epoch > 0 ? g.history.get(r.epoch - 1)?.rec : undefined;
    }
    return since;
  }

  private async applyPendingRecs(g: Group, from: string): Promise<void> {
    for (;;) {
      const list = g.pendingRecs.get(g.rec.epoch + 1);
      if (!list) break;
      g.pendingRecs.delete(g.rec.epoch + 1);
      const r = list.find((x) => checkNext(g.rec, x));
      if (!r) break;
      const before = g.rec;
      await this.applyNext(g, r, false);
      this.forward(r, before, from);
      if (g.status === 'joined') await this.rotate(g);
    }
    for (const e of g.pendingRecs.keys()) if (e <= g.rec.epoch) g.pendingRecs.delete(e);
  }

  /** Passes a record I just learned to members I can reach (they ignore ones they have). */
  private forward(r: GroupRecord, before: GroupRecord, from: string): void {
    for (const m of new Set([...r.members, ...before.members].map((x) => x.p2pId))) {
      if (m === this.myId || m === from || !this.reachable(m)) continue;
      if (this.isMember(before, m)) this.direct(m, { k: 'g-rec', gid: r.id, recs: [r] });
      else this.direct(m, this.inviteFrame(r));
    }
  }

  /** An invite carries the genesis, so the newcomer can check the id and then the chain. */
  private inviteFrame(rec: GroupRecord): GroupFrame {
    const gen = this.groups.get(rec.id)?.gen;
    return gen ? { k: 'g-invite', gid: rec.id, rec, gen } : { k: 'g-invite', gid: rec.id, rec };
  }

  private async applyNext(g: Group, r: GroupRecord, rotate = true): Promise<void> {
    const before = g.rec;
    g.history.set(before.epoch, { rec: before, rh: g.rh });
    g.epochEnded.set(before.epoch, this.o.now());
    // The whole chain is kept (newcomers check it from the genesis), up to KEEP_RECORDS.
    for (const e of g.history.keys()) if (e < r.epoch - KEEP_RECORDS) g.history.delete(e);
    g.rec = r;
    g.rh = recordHash(r);
    this.afterRecord(g);
    if (rotate && g.status === 'joined') await this.rotate(g);
    if (g.status !== 'removed' && g.status !== 'left') this.emit('group', this.info(g));
  }

  private afterRecord(g: Group): void {
    if (!this.isMember(g.rec, this.myId) && (g.status === 'joined' || g.status === 'invited')) {
      g.status = 'removed';
      g.keys.clear();
      g.myKeys.clear();
      this.emit('removed', this.info(g));
    } else if (this.isMember(g.rec, this.myId) && (g.status === 'removed' || g.status === 'left')) {
      // Added again by an admin after being removed (or leaving): Join / Leave is shown again.
      g.status = 'invited';
      g.invitedBy = g.rec.by;
      this.emit('invite', this.info(g), g.rec.by);
    }
    // Keys of old epochs are kept a little (late messages), then dropped.
    for (const k of g.keys.keys()) {
      const [e] = k.split('|');
      if (Number(e) < g.rec.epoch - 3) g.keys.delete(k);
    }
    for (const e of g.myKeys.keys()) if (e < g.rec.epoch - 3) g.myKeys.delete(e);
  }

  /** A new sender key for the current epoch, sent to every other member. */
  private async rotate(g: Group): Promise<void> {
    const key = crypto.getRandomValues(new Uint8Array(32));
    g.myKeys.set(g.rec.epoch, { rh: g.rh, key });
    this.addKey(g, g.rec.epoch, this.myId, key);
    for (const m of g.rec.members) if (m.p2pId !== this.myId) await this.sendMyKeyTo(g, m.p2pId);
  }

  private async sendMyKeyTo(g: Group, to: string): Promise<void> {
    const mine = g.myKeys.get(g.rec.epoch);
    const m = g.rec.members.find((x) => x.p2pId === to);
    if (!mine || !m || g.status !== 'joined') return;
    const f = await sealKey(this.me, this.myId, g.rec.id, g.rec.epoch, mine.rh, m, mine.key);
    if (this.direct(to, f)) return;
    // Not reachable: wait for them, and ask members I can reach to carry it (it's sealed to them).
    this.deliver(to, f);
    this.markSeen(this.keyId(f));
    this.markRelayed(this.keyId(f));
    let n = 0;
    for (const x of g.rec.members) {
      if (n >= this.o.relayFanout) break;
      if (x.p2pId !== this.myId && x.p2pId !== to && this.direct(x.p2pId, { ...f, hop: 0, want: [to] })) n++;
    }
  }

  private keyId = (f: KeyFrame) => 'k' + f.sig.slice(0, 22);

  private addKey(g: Group, epoch: number, owner: string, key: Uint8Array): boolean {
    const id = `${epoch}|${owner}`;
    const list = g.keys.get(id) ?? [];
    if (list.some((k) => k.length === key.length && k.every((b, i) => b === key[i]))) return false;
    list.push(key);
    if (list.length > 4) list.shift();
    g.keys.set(id, list);
    return true;
  }

  private async onKey(from: string, f: KeyFrame): Promise<void> {
    if (
      !isStr(f.gid, 64) ||
      !Number.isSafeInteger(f.epoch) ||
      !isStr(f.owner, 24) ||
      !isStr(f.to, 24) ||
      !isStr(f.sig, 100) ||
      !isStr(f.ct, 200) ||
      !isStr(f.eph, 64) ||
      !isStr(f.rh, 64)
    )
      return;
    const g = this.groups.get(f.gid);
    if (!g && this.joining.has(f.gid)) {
      // Keys sent right after an invite whose chain is still being checked: wait for it.
      return this.queueKey(f, this.joining.get(f.gid)!.target);
    }
    if (!g || g.status === 'left' || g.status === 'removed' || !this.knownPeer(g, from)) return;
    const id = this.keyId(f);
    if (f.epoch > g.rec.epoch) return this.queueKey(f, g.rec);
    const at = this.recAt(g, f.epoch);
    if (!at || !this.isMember(at.rec, f.owner) || !this.isMember(at.rec, f.to)) return;
    if (!verify(memberKey(at.rec, f.owner)!, keySigBytes(f), fromB64url(f.sig))) return;
    if (f.to !== this.myId) return this.relay(g, from, f, id, f.owner);
    if (this.seen.has(id)) return;
    let key: Uint8Array;
    try {
      key = await openKey(this.me, f);
    } catch {
      return;
    }
    this.markSeen(id);
    if (this.addKey(g, f.epoch, f.owner, key)) await this.retryPending();
  }

  private async onMsg(from: string, f: MsgFrame): Promise<void> {
    if (
      !isStr(f.gid, 64) ||
      !Number.isSafeInteger(f.epoch) ||
      !isStr(f.mid, 24) ||
      !isStr(f.from, 24) ||
      typeof f.ts !== 'number' ||
      !isStr(f.ct, MAX_TEXT * 2) ||
      !isStr(f.sig, 100)
    )
      return;
    if (this.seen.has(f.mid)) return this.ack(from, f.mid);
    const g = this.groups.get(f.gid);
    if (!g && this.joining.has(f.gid)) return this.pend(f, this.joining.get(f.gid)!.target, from);
    if (!g) return void this.requested.delete(f.mid); // not loaded (yet): ask again when offered again
    if (g.status === 'left' || g.status === 'removed' || !this.knownPeer(g, from)) return;
    if (f.epoch > g.rec.epoch) {
      // From a newer epoch than I know: wait for the record and the key.
      this.pend(f, g.rec);
      if (this.reachable(from)) this.direct(from, { k: 'g-sync', gid: f.gid, epoch: g.rec.epoch, rh: g.rh });
      return;
    }
    const at = this.recAt(g, f.epoch);
    if (!at || !this.isMember(at.rec, f.from)) return;
    if (f.epoch < g.rec.epoch && !this.oldEpochOk(g, f, this.o.now())) return;
    if (!verify(memberKey(at.rec, f.from)!, msgSigBytes(f), fromB64url(f.sig))) return;
    await this.relay(g, from, f, f.mid, f.from);
    if (g.status !== 'joined') {
      this.pend(f, undefined, from);
      return;
    }
    if (await this.tryOpen(g, f)) this.ack(from, f.mid);
    else this.pend(f, undefined, from);
  }

  /**
   * A message for an epoch that has ended (M-4). Only when all of these hold:
   *  - it arrived (`receivedAt`) within oldEpochGraceMs after that epoch ended here (in-flight messages);
   *  - it is dated no later than the record that ended the epoch (+ OLD_EPOCH_SKEW_MS for clocks);
   *  - its sender is still a member now (a removed member can't post with the old key, back-dated or not).
   * It must also open with the sender's key of THAT epoch (tryOpen), i.e. the key issued in it.
   */
  private oldEpochOk(g: Group, f: MsgFrame, receivedAt: number): boolean {
    const ended = g.epochEnded.get(f.epoch);
    if (ended === undefined || receivedAt - ended > this.o.oldEpochGraceMs) return false;
    const next = this.recAt(g, f.epoch + 1)?.rec;
    if (!next || f.ts > next.ts + OLD_EPOCH_SKEW_MS) return false;
    return this.isMember(g.rec, f.from);
  }

  /**
   * Frames that wait (for a record or a key) are checked first where possible (L-5): signed by the
   * sender's key as the latest record I have knows it (identity keys don't change between epochs),
   * and at most PER_SENDER_QUEUED per sender, so one member can't fill the queue and push out others.
   */
  private queueOk(rec: GroupRecord | undefined, who: string, bytes: Uint8Array, sig: string, queued: number): boolean {
    if (queued >= PER_SENDER_QUEUED) return false;
    const key = rec && memberKey(rec, who);
    if (!key) return true; // a member added in an epoch I don't have yet: only the cap applies
    try {
      return verify(key, bytes, fromB64url(sig));
    } catch {
      return false;
    }
  }

  private queueKey(f: KeyFrame, rec?: GroupRecord): void {
    if (this.pendingKeys.length >= 500) return;
    const n = this.pendingKeys.filter((p) => p.f.owner === f.owner).length;
    if (this.queueOk(rec, f.owner, keySigBytes(f), f.sig, n)) this.pendingKeys.push({ f, at: this.o.now() });
  }

  private pend(f: MsgFrame, rec?: GroupRecord, via?: string): void {
    if (this.pendingMsgs.length >= 500 || this.pendingMsgs.some((p) => p.f.mid === f.mid)) return;
    const n = this.pendingMsgs.filter((p) => p.f.from === f.from).length;
    if (this.queueOk(rec, f.from, msgSigBytes(f), f.sig, n)) this.pendingMsgs.push({ f, at: this.o.now(), via });
  }

  /** Ids already passed on (bounded, oldest dropped first). */
  private markRelayed(id: string): void {
    this.relayed.add(id);
    if (this.relayed.size > 20_000) this.relayed.delete(this.relayed.values().next().value!);
  }

  private async tryOpen(g: Group, f: MsgFrame): Promise<boolean> {
    if (this.seen.has(f.mid)) return true;
    for (const key of g.keys.get(`${f.epoch}|${f.from}`) ?? []) {
      let body: unknown;
      try {
        body = await openGroupMessage(key, f);
      } catch {
        continue;
      }
      this.markSeen(f.mid);
      const name = this.recAt(g, f.epoch)?.rec.members.find((m) => m.p2pId === f.from)?.name ?? '';
      this.emit('message', { gid: f.gid, mid: f.mid, from: f.from, fromName: name, ts: f.ts, body });
      return true;
    }
    return false;
  }

  /** Messages / keys that waited for a record or a key. */
  private async retryPending(): Promise<void> {
    const now = this.o.now();
    const keys = this.pendingKeys;
    this.pendingKeys = [];
    for (const { f, at } of keys) {
      const g = this.groups.get(f.gid);
      if (now - at > this.o.keepMs) continue;
      if (!g) {
        if (this.joining.has(f.gid)) this.pendingKeys.push({ f, at }); // its invite is still being checked
        continue;
      }
      if (f.epoch > g.rec.epoch) this.pendingKeys.push({ f, at });
      else await this.onKey(f.owner, f);
    }
    const msgs = this.pendingMsgs;
    this.pendingMsgs = [];
    for (const { f, at, via } of msgs) {
      const g = this.groups.get(f.gid);
      if (!g && this.joining.has(f.gid) && now - at <= this.o.keepMs) {
        this.pendingMsgs.push({ f, at, via });
        continue;
      }
      if (!g || now - at > this.o.keepMs || g.status === 'left' || g.status === 'removed' || this.seen.has(f.mid)) continue;
      if (f.epoch > g.rec.epoch || g.status !== 'joined') {
        this.pendingMsgs.push({ f, at, via });
        continue;
      }
      const rec = this.recAt(g, f.epoch)?.rec;
      if (!rec || !this.isMember(rec, f.from) || !verify(memberKey(rec, f.from)!, msgSigBytes(f), fromB64url(f.sig))) continue;
      if (f.epoch < g.rec.epoch && !this.oldEpochOk(g, f, at)) continue; // judged by when it arrived
      if (await this.tryOpen(g, f)) {
        if (via) this.ack(via, f.mid);
      } else this.pendingMsgs.push({ f, at, via });
    }
  }

  /**
   * Pass a frame on to members in its `want` list: now if I can reach them, else keep it for when
   * they connect. At most MAX_HOPS hops; each frame is passed on once.
   */
  private async relay(g: Group, from: string, f: MsgFrame | KeyFrame, id: string, origin: string): Promise<void> {
    const hop = Number.isSafeInteger(f.hop) ? (f.hop as number) : MAX_HOPS;
    const want = Array.isArray(f.want) ? f.want.filter((x) => typeof x === 'string').slice(0, MAX_MEMBERS) : [];
    if (hop >= MAX_HOPS || !want.length || this.relayed.has(id)) return;
    this.markRelayed(id);
    const targets = want.filter((p) => p !== this.myId && p !== origin && p !== from && this.isMember(g.rec, p));
    const near = targets.filter((p) => this.reachable(p));
    const far = targets.filter((p) => !this.reachable(p));
    // To those I reach: one more hop, and they may carry it on to the ones I can't reach.
    for (const p of near) this.direct(p, { ...f, hop: hop + 1, want: hop + 1 < MAX_HOPS ? far : [] });
    // Kept for all of them until they say they have it (a connection that looks open may be dead).
    this.keep({ ...f, hop: hop + 1, want: [] }, g.rec.id, targets);
  }

  private onLeave(from: string, w: Extract<GroupFrame, { k: 'g-leave' }>): Promise<void> | void {
    const g = this.groups.get(w.gid);
    if (!g || w.from !== from || !this.isMember(g.rec, w.from) || typeof w.ts !== 'number') return;
    if (!verify(memberKey(g.rec, w.from)!, leaveBytes(w.gid, w.from, w.epoch, w.ts), fromB64url(w.sig))) return;
    if (this.o.autoRemoveLeavers && g.status === 'joined' && g.rec.admins.includes(this.myId)) {
      return this.changeNow(w.gid, (r) => this.withoutMembers(r, [w.from])).catch(() => undefined);
    }
  }

  private onSync(from: string, w: Extract<GroupFrame, { k: 'g-sync' }>): void {
    if (!isStr(w.gid, 64) || !Number.isSafeInteger(w.epoch)) return;
    const g = this.groups.get(w.gid);
    if (!g) {
      // A group they have and I don't (BUG-10: my app closed before my join was saved): say so, once
      // a minute, and a member who has it sends me the invite again.
      if (w.epoch >= 0 && !this.joining.has(w.gid)) {
        const k = `${from}|${w.gid}`;
        const now = this.o.now();
        if (now - (this.missingAsked.get(k) ?? -Infinity) > 60_000) {
          this.missingAsked.set(k, now);
          this.direct(from, { k: 'g-sync', gid: w.gid, epoch: -1, rh: '' });
        }
      }
      return;
    }
    if (!this.knownPeer(g, from)) return;
    if (w.epoch === -1) {
      // "I don't have this group": if they are in it now, the invite again (genesis + current record).
      if (g.status === 'joined' && this.isMember(g.rec, from)) {
        this.direct(from, this.inviteFrame(g.rec));
      }
      return;
    }
    // They (re)connected, joined, or finished loading their groups after connecting: my current sender
    // key (they may not have it: a join that was lost and made again) and what I keep for them.
    if (g.status === 'joined' && this.isMember(g.rec, from)) void this.sendMyKeyTo(g, from);
    this.offerKept(from, w.gid);
    if (w.epoch < g.rec.epoch) {
      const recs: GroupRecord[] = [];
      for (let e = w.epoch + 1; e <= g.rec.epoch; e++) {
        const r = this.recAt(g, e)?.rec;
        if (r) recs.push(r);
      }
      // In batches, so one frame stays well under WebRTC's message size (a removed member learns it too).
      for (let i = 0; i < recs.length; i += 8) this.direct(from, { k: 'g-rec', gid: w.gid, recs: recs.slice(i, i + 8) });
    } else if (w.epoch === g.rec.epoch && w.rh !== g.rh) {
      this.direct(from, { k: 'g-rec', gid: w.gid, recs: [g.rec] }); // two versions: the lowest hash wins
    }
  }

  // ---- keeping frames for members who are away -------------------------------------------------------

  private keep(frame: MsgFrame | KeyFrame, gid: string, targets: string[]): void {
    if (!targets.length) return;
    const id = frame.k === 'g-msg' ? frame.mid : this.keyId(frame);
    const now = this.o.now();
    const k = this.kept.get(id);
    if (k) targets.forEach((t) => k.targets.add(t));
    else this.kept.set(id, { frame, gid, targets: new Set(targets), expires: now + this.o.keepMs });
    this.trimKept(gid);
  }

  /** At most maxKeptPerGroup per group and maxKept in all; the oldest go first. */
  private trimKept(gid: string): void {
    let inGroup = 0;
    for (const k of this.kept.values()) if (k.gid === gid) inGroup++;
    for (const [id, k] of this.kept) {
      if (inGroup <= this.o.maxKeptPerGroup) break;
      if (k.gid !== gid) continue;
      this.kept.delete(id);
      inGroup--;
    }
    while (this.kept.size > this.o.maxKept) this.kept.delete(this.kept.keys().next().value!);
  }

  /** The inventory of frames I keep for `peer` (all groups, or one). */
  private offerKept(peer: string, gid?: string): void {
    const now = this.o.now();
    const ids: string[] = [];
    for (const [id, k] of this.kept) {
      if (k.expires < now) {
        this.kept.delete(id);
        continue;
      }
      if (k.targets.has(peer) && (!gid || k.gid === gid)) ids.push(id);
    }
    for (let i = 0; i < ids.length; i += 200) this.direct(peer, { k: 'g-inv', ids: ids.slice(i, i + 200) });
    // Older builds never say what they have: offered once is as far as it goes for them (old behaviour).
    if (this.legacy.has(peer)) for (const id of ids) this.dropTarget(id, peer);
  }

  private dropTarget(id: string, peer: string): void {
    const k = this.kept.get(id);
    if (!k) return;
    k.targets.delete(peer);
    if (!k.targets.size) this.kept.delete(id);
  }

  private onInv(from: string, ids: string[]): void {
    if (!Array.isArray(ids)) return;
    const now = this.o.now();
    const list = ids.slice(0, 200).filter((id): id is string => typeof id === 'string' && id.length <= 32);
    // The ones I have already: tell them, so they stop keeping them for me.
    for (const id of list) if (this.seen.has(id)) this.ack(from, id);
    const want = list.filter((id) => !this.seen.has(id) && !(now - (this.requested.get(id) ?? -Infinity) < 10_000));
    want.forEach((id) => this.requested.set(id, now));
    if (want.length) this.direct(from, { k: 'g-req', ids: want, ack: 1 });
  }

  /** They asked for kept frames: send them (they stay kept until the g-ack). */
  private onReq(from: string, ids: string[], acks: boolean): void {
    if (!Array.isArray(ids)) return;
    if (acks) this.legacy.delete(from);
    else this.legacy.add(from);
    for (const id of ids.slice(0, 200)) {
      const k = typeof id === 'string' ? this.kept.get(id) : undefined;
      if (!k || !k.targets.has(from)) continue;
      this.direct(from, k.frame);
      // Older builds never send g-ack: for them a request is as good as one (the old behaviour).
      if (!acks) this.dropTarget(id, from);
    }
  }

  private onAck(from: string, ids: string[]): void {
    if (!Array.isArray(ids)) return;
    for (const id of ids.slice(0, 500)) if (typeof id === 'string') this.dropTarget(id, from);
  }

  /** "I have it" to the member who gave it to me (batched). */
  private ack(to: string, id: string): void {
    if (to === this.myId) return;
    const set = this.acks.get(to) ?? new Set();
    set.add(id);
    this.acks.set(to, set);
    this.ackTimer ??= setTimeout(() => this.flushAcks(), ACK_DELAY_MS);
  }

  private flushAcks(): void {
    this.ackTimer = null;
    for (const [to, set] of this.acks) {
      const ids = [...set];
      for (let i = 0; i < ids.length; i += 500) this.direct(to, { k: 'g-ack', ids: ids.slice(i, i + 500) });
    }
    this.acks.clear();
  }

  private markSeen(id: string): void {
    this.seen.set(id, this.o.now());
    if (this.seen.size > 20_000) this.seen.delete(this.seen.keys().next().value!);
    this.requested.delete(id);
  }

  // ---- state ----------------------------------------------------------------------------------------------

  private newGroup(rec: GroupRecord, status: GroupStatus): Group {
    return { rec, rh: recordHash(rec), status, history: new Map(), pendingRecs: new Map(), keys: new Map(), myKeys: new Map(), epochEnded: new Map(), gen: null };
  }

  /**
   * Everything needed to carry on after a restart (records, keys). Contains secret keys: store it
   * locked (Phase 1 store) and never send it anywhere.
   */
  exportState(): GroupsState {
    const now = this.o.now();
    return {
      v: 1,
      groups: [...this.groups.values()].map((g) => ({
        rec: g.rec,
        status: g.status,
        history: [...g.history.values()].map((h) => h.rec),
        keys: [...g.keys].flatMap(([id, list]) => list.map((k) => [id, toB64url(k)] as [string, string])),
        myKeys: [...g.myKeys].map(([e, k]) => [e, k.rh, toB64url(k.key)] as [number, string, string]),
        epochEnded: [...g.epochEnded],
        invitedBy: g.invitedBy,
        ...(g.gen ? { gen: g.gen } : {}),
      })),
      // Frames I keep for members who were away (they go on waiting after a restart), and the ids I
      // have read (a frame offered again after a restart is not shown twice).
      kept: [...this.kept]
        .filter(([, k]) => k.expires > now && k.targets.size)
        .map(([id, k]) => ({ id, gid: k.gid, frame: k.frame, targets: [...k.targets], expires: k.expires })),
      seen: [...this.seen].filter(([, at]) => now - at < this.o.keepMs).slice(-SEEN_SAVED),
    };
  }

  importState(s: GroupsState): void {
    if (s?.v !== 1) return;
    for (const x of s.groups) {
      const g = this.newGroup(x.rec, x.status);
      for (const r of x.history) g.history.set(r.epoch, { rec: r, rh: recordHash(r) });
      for (const [id, k] of x.keys) {
        const [e, owner] = id.split('|');
        this.addKey(g, Number(e), owner, fromB64url(k));
      }
      for (const [e, rh, k] of x.myKeys) g.myKeys.set(e, { rh, key: fromB64url(k) });
      g.epochEnded = new Map(x.epochEnded);
      g.invitedBy = x.invitedBy;
      // The genesis (binds the id). Groups made before ids were bound have none: no new members.
      const gen = x.gen ?? (x.rec.epoch === 0 ? x.rec : g.history.get(0)?.rec);
      g.gen = gen && gen.id === x.rec.id && checkGenesis(gen) ? gen : null;
      this.groups.set(x.rec.id, g);
    }
    const now = this.o.now();
    for (const [id, at] of Array.isArray(s.seen) ? s.seen : []) if (typeof id === 'string' && typeof at === 'number' && !this.seen.has(id)) this.seen.set(id, at);
    for (const k of Array.isArray(s.kept) ? s.kept : []) {
      const f = k?.frame;
      if (!f || (f.k !== 'g-msg' && f.k !== 'g-key') || !this.groups.has(k.gid) || !(k.expires > now) || !Array.isArray(k.targets)) continue;
      const have = this.kept.get(k.id);
      if (have) k.targets.forEach((t) => have.targets.add(t));
      else this.kept.set(k.id, { frame: f, gid: k.gid, targets: new Set(k.targets), expires: k.expires });
    }
    for (const gid of new Set((s.kept ?? []).map((k) => k.gid))) this.trimKept(gid);
    // Channels attached before the saved groups were loaded (the app connects while it is still
    // reading them): what they sent for these groups was dropped, so greet them again now (BUG-6).
    this.requested.clear();
    for (const peer of this.channels.keys()) this.greet(peer);
  }
}

export interface GroupsState {
  v: 1;
  groups: {
    rec: GroupRecord;
    status: GroupStatus;
    history: GroupRecord[];
    keys: [string, string][];
    myKeys: [number, string, string][];
    epochEnded: [number, number][];
    invitedBy?: string;
    /** The genesis record (missing for groups made before group ids were bound to it). */
    gen?: GroupRecord;
  }[];
  /** Frames kept for members who were away (missing in states saved before 23 Oct 2026). */
  kept?: { id: string; gid: string; frame: MsgFrame | KeyFrame; targets: string[]; expires: number }[];
  /** Ids of frames already read, with when (missing in older states). */
  seen?: [string, number][];
}
