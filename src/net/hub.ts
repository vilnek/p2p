// Background relay work while the app is open:
//   - my invites (sender): stored contact requests and live offers; Accept / Block; "already used" replies;
//   - my pending requests (receiver): the stored acceptance (or "already used");
//   - my contacts: the live hello on a topic derived from both keys, both ways.
// Plus joinInvite() for the person who opens an invite link.
//
// Everything on the relays is locked (X25519 -> HKDF -> AES-256-GCM, see core/card.ts) and signed
// inside by the identity keys; relays see random-looking tags and blobs only.

import { x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { concat, fromB64url, fromHex, fromUtf8, toB64url, toHex, utf8 } from '../core/bytes';
import {
  CardError,
  INVITE_USED_TEXT,
  offerTag,
  openBox,
  openReply,
  replyTag,
  sealReply,
  sealToBox,
  type Card,
} from '../core/card';
import { emojiCode, p2pId, sign, verify } from '../core/identity';
import { checkIdCard, idCardTag, makeIdCard, type IdCard } from '../core/idcard';
import {
  openPairNote,
  openPairOffer,
  memberPairKeys,
  openPairReply,
  pairKeys,
  pairListenTags,
  pairSendTags,
  pairTagsAround,
  sealPairNote,
  sealPairOffer,
  sealPairReply,
  type PairKeys,
} from '../core/pair';
import {
  addBlocked,
  addDeletedContact,
  loadDeletedContacts,
  removeDeletedContact,
  type DeletedContact,
  deleteContact,
  deletePending,
  loadBlocked,
  loadPublished,
  savePublished,
  loadCardPublishedAt,
  saveCardPublishedAt,
  loadContacts,
  loadInvites,
  loadPending,
  saveContact,
  saveInvite,
  savePending,
  type Contact,
  type InviteRecord,
  type PendingRecord,
} from '../core/store';
import { decodeCode, verifyCode } from '../core/signal';
import { searchRelays } from './config';
import { testFlag } from '../core/testmode';
import { RelaysUnreachable } from './oneScan';
import { Peer, findPeer, hasLivePeer, onLost, onRescue, type Me } from './peer';
import { RelayPool, SIGNAL_KIND, STORED_KIND } from './relay';

const REFRESH_MS = 30_000;
/** Phones with a wrong clock are common: stored messages are asked for with a day of slack. */
const CLOCK_SLACK_S = 24 * 3600;
/** ?debug=1 only: a few quiet events are logged to the console (never in normal use). */
const DEBUG = testFlag('debug') === '1';
const CONTACT_WAIT_MS = 8000;
const LIVE_WAIT_MS = 8000;
/** After the first seconds, how often an open invite page keeps offering a live connection. */
const SLOW_OFFER_MS = 10_000;
/** How long the winner of a reconnect repeats its "taken" note for the other devices. */
const TAKEN_MS = 12_000;
/** A reconnect answer that never connects (another device won, and the note was missed) ends after this. */
const ANSWER_GIVE_UP_MS = 35_000;
/** "Findable by my ID": the card is published again this often while the app is open (relays keep it 24 h). */
const CARD_REPUBLISH_MS = 20 * 3600_000;
/** Spam limits (security review M-7): requests per invite or ID box per hour, and waiting requests in all. */
const REQUESTS_PER_BOX_HOUR = 20;
const MAX_WAITING_REQUESTS = 50;
/** How long "Type their P2P ID" looks for their card. */
export const FIND_WAIT_MS = 8000;
/** The request box behind "Findable by my ID" never expires by itself. */
const ID_BOX_EXPIRES = 8.64e15;
/** An ICE restart offer / answer through the relays is repeated this long (BUG-8). */
const RESCUE_MS = 18_000;
/** A connection lost by itself (network) is quietly made again: after these pauses (BUG-8). */
const RECONNECT_AFTER_MS = [1500, 5000, 15_000];

// ---- messages ---------------------------------------------------------------------------------------

/** A contact request: B -> A, locked to A's invite box. */
export interface ContactRequest {
  t: 'req';
  k: string; // B's identity key
  n: string; // B's name
  note: string;
  rb: string; // B's reply box key (X25519)
  rr: string[]; // B's relays
  ts: number;
  g: string; // B's signature
}

interface Acceptance {
  t: 'accept';
  k: string;
  n: string;
  rr: string[];
  g: string;
}

type BoxReply = { t: 'used' } | Acceptance;

const reqBytes = (inviteId: string, r: Omit<ContactRequest, 'g' | 't'>) =>
  utf8(JSON.stringify(['p2ptalk-req-v1', inviteId, r.k, r.n, r.note, r.rb, r.rr, r.ts]));
const acceptBytes = (inviteId: string, a: Omit<Acceptance, 'g' | 't'>, rb: string) =>
  utf8(JSON.stringify(['p2ptalk-accept-v1', inviteId, a.k, a.n, a.rr, rb]));

/** Only short, well-typed strings reach the screens (the signature proves the sender chose them, no more). */
const okRelays = (rr: unknown): rr is string[] => Array.isArray(rr) && rr.length <= 8 && rr.every((x) => typeof x === 'string' && x.length <= 255);

export function verifyRequest(inviteId: string, r: ContactRequest): boolean {
  if (r?.t !== 'req' || typeof r.k !== 'string' || typeof r.rb !== 'string' || typeof r.g !== 'string') return false;
  if (typeof r.n !== 'string' || r.n.length > 40 || typeof r.note !== 'string' || r.note.length > 140) return false;
  if (!okRelays(r.rr) || typeof r.ts !== 'number') return false;
  try {
    return verify(fromB64url(r.k), reqBytes(inviteId, r), fromB64url(r.g));
  } catch {
    return false;
  }
}

/** What a reconnect offer is bound to: the contact pair, or the group-member pair (a different string). */
const bindOf = (pair: PairKeys, gid?: string) => (gid ? `member:${toHex(pair.id)}` : `pair:${toHex(pair.id)}`);

const replyBoxTag = (rbPub: Uint8Array) => toHex(sha256(concat(utf8('p2ptalk-replybox-v1'), rbPub)));

// ---- the hub --------------------------------------------------------------------------------------------

export interface HubEvents {
  /** A live connection was made (contact hello, or someone used my invite while I was online). */
  peer(p: Peer, note: string): void;
  /** Someone sent a request on one of my invites (I was offline). */
  request(invite: InviteRecord, req: ContactRequest): void;
  /** Someone accepted my request: they are now a contact. */
  accepted(c: Contact): void;
  /** My request was refused (invite already used / cancelled). */
  refused(p: PendingRecord): void;
  /** Something in the lists changed. */
  changed(): void;
  /** Another device of this account took a reconnect this device had answered (it ended quietly). */
  taken?(c: Contact): void;
}

/** A group I am in, as the hub needs it: the members of its CURRENT signed record (groups.ts). */
export interface MemberGroup {
  gid: string;
  members: { p2pId: string; identityKey: string; name: string }[];
}

/** Most group-member reconnect subscriptions at once (members who are not contacts). */
const MAX_MEMBER_SUBS = 300;

export class Hub {
  /**
   * The groups I am in (set by the app from GroupManager.list(), joined groups only). Members who share
   * a group can connect without being contacts ("group member" links, INTEGRATION_FILES_GROUPS.md §3.2).
   */
  groupMembers: () => MemberGroup[] = () => [];
  private pool: RelayPool | null = null;
  private poolKey = '';
  private unsubs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private handled = new Set<string>();
  /** Requests counted per invite / ID box in the current hour (spam limit). */
  private boxCounts = new Map<string, { hour: number; n: number }>();
  /** Invite id -> the identity whose live offer I answered. */
  private liveBy = new Map<string, string>();
  /** Requests waiting for Accept / Block, by invite id + identity key. */
  readonly requests = new Map<string, { invite: InviteRecord; req: ContactRequest }>();
  private connecting = new Set<string>();
  private hooks: (() => void)[] | null = null;
  /** Restart offers already being carried, per connection (the same offer is not posted twice). */
  private rescuing = new WeakMap<Peer, string>();
  /** Contacts being reconnected quietly after a lost connection. */
  private reconnecting = new Set<string>();
  private refreshing: Promise<void> | null = null;
  /** Identity keys (base64url) I blocked. */
  private blocked = new Set<string>();
  /** People I deleted who tried to reconnect: "<name> wants to talk again" (Accept / Block), by identity key. */
  readonly againRequests = new Map<string, DeletedContact>();

  /**
   * `canTake(contactId)`: may a reconnect from this contact be answered now? (False while talking to
   * someone else on a one-connection screen, or while in a call with them.)
   */
  constructor(
    private readonly me: Me,
    private readonly relaysFor: () => Promise<string[]>,
    private readonly allowed: () => string[],
    private readonly ev: HubEvents,
    private readonly canTake: (contactId: string) => boolean,
  ) {}

  start(): void {
    void this.refresh();
    this.timer ??= setInterval(() => void this.refresh(), REFRESH_MS);
    this.hooks ??= [onRescue((p, offer) => void this.sendRescue(p, offer)), onLost((p) => void this.reconnectLost(p))];
  }

  stop(): void {
    this.hooks?.forEach((u) => u());
    this.hooks = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubs.forEach((u) => u());
    this.pool?.close();
    this.pool = null;
  }

  /** Re-reads invites, pending requests and contacts, and (re)subscribes on the relays. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      // One is running with older data: run once more after it.
      this.again ??= this.refreshing.then(() => {
        this.again = null;
        return this.refresh();
      });
      return this.again;
    }
    this.refreshing = this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }
  private again: Promise<void> | null = null;

  private async doRefresh(): Promise<void> {
    const now = Date.now();
    const [invites, pending, contacts, mine, blocked, deletedAll] = await Promise.all([loadInvites(), loadPending(), loadContacts(), this.relaysFor(), loadBlocked(), loadDeletedContacts()]);
    this.blocked = new Set(blocked);
    const contactKeys = new Set(contacts.map((c) => c.publicKey));
    const deleted = deletedAll.filter((d) => !contactKeys.has(d.publicKey) && !this.blocked.has(d.publicKey));
    for (const k of this.againRequests.keys()) if (contactKeys.has(k) || this.blocked.has(k)) this.againRequests.delete(k);
    const liveInvites = invites.filter((i) => i.expires > now && (i.kind !== 'id' || i.status === 'waiting'));
    const livePending = pending.filter((p) => p.expires + 24 * 3600_000 > now);
    const members = this.memberLinks();
    if (!liveInvites.length && !livePending.length && !contacts.length && !members.length && !deleted.length) {
      this.unsubs.forEach((u) => u());
      this.unsubs = [];
      this.pool?.close();
      this.pool = null;
      this.poolKey = '';
      return;
    }
    const allowed = new Set(this.allowed());
    const relays = [
      ...new Set([
        ...mine,
        ...liveInvites.flatMap((i) => i.relays),
        ...livePending.flatMap((p) => p.relays),
        ...contacts.flatMap((c) => c.relays ?? []),
        ...deleted.flatMap((d) => d.relays),
        // Group records carry no relays: members meet on the built-in ones.
        ...(members.length ? searchRelays() : []),
      ]),
    ].filter((r) => allowed.has(r));
    const key = relays.sort().join(' ');
    if (!this.pool || this.pool.isClosed || key !== this.poolKey || !this.pool.open().length) {
      this.pool?.close();
      this.pool = new RelayPool(relays);
      this.poolKey = key;
      await this.pool.connect(6000);
    }
    const pool = this.pool;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];

    const idBox = liveInvites.find((i) => i.kind === 'id');
    if (idBox && now - this.cardAt > CARD_REPUBLISH_MS) void this.publishCard(idBox);
    for (const inv of liveInvites) {
      this.unsubs.push(
        pool.subscribe(
          // "since" allows a day of clock difference: the other phone's clock may be wrong (content is locked and deduped).
          { kinds: [STORED_KIND, SIGNAL_KIND], tags: [offerTag(fromHex(inv.id))], since: Math.floor(inv.created / 1000) - CLOCK_SLACK_S },
          (content) => void this.onInviteMessage(inv.id, content),
        ),
      );
    }
    for (const p of livePending) {
      this.unsubs.push(
        pool.subscribe({ kinds: [STORED_KIND], tags: [replyBoxTag(p.replyPub)], since: Math.floor(p.sentAt / 1000) - CLOCK_SLACK_S }, (content) =>
          void this.onPendingReply(p, content),
        ),
      );
    }
    for (const c of contacts) {
      const pair = this.pair(c);
      this.unsubs.push(
        pool.subscribe({ kinds: [SIGNAL_KIND], tags: pairTagsAround(pair.secret, 'offer') }, (content) => void this.onContactOffer(c, pair, content)),
      );
    }
    // People I deleted: their reconnect offers become a request (never answered by themselves).
    for (const d of deleted) {
      const pair = this.pair({ publicKey: d.publicKey } as Contact);
      this.unsubs.push(pool.subscribe({ kinds: [SIGNAL_KIND], tags: pairTagsAround(pair.secret, 'offer') }, (content) => void this.onDeletedOffer(d, pair, content)));
    }
    // Members of my groups (contacts too: one of us may not have the other as a contact).
    for (const { gid, member } of members) {
      const pair = this.memberPair(member.identityKey, gid);
      const c = this.memberContact(member);
      this.unsubs.push(
        pool.subscribe({ kinds: [SIGNAL_KIND], tags: pairTagsAround(pair.secret, 'offer') }, (content) => void this.onContactOffer(c, pair, content, gid)),
      );
    }
  }

  // ---- group members who are not contacts ------------------------------------------------------------

  private memberPairCache = new Map<string, PairKeys>();
  private memberPair(identityKey: string, gid: string): PairKeys {
    const k = `${gid}|${identityKey}`;
    let pair = this.memberPairCache.get(k);
    if (!pair) {
      pair = memberPairKeys(this.me.secretKey, this.me.publicKey, fromB64url(identityKey), gid);
      this.memberPairCache.set(k, pair);
    }
    return pair;
  }

  private memberContact(m: MemberGroup['members'][number]): Contact {
    return { id: m.p2pId, publicKey: m.identityKey, name: m.name, lastSeen: 0, relays: searchRelays() };
  }

  /** Every (group, other member) pair where both of us are in the group's current record. */
  private memberLinks(): { gid: string; member: MemberGroup['members'][number] }[] {
    const myKey = toB64url(this.me.publicKey);
    const myId = p2pId(this.me.publicKey);
    const out: { gid: string; member: MemberGroup['members'][number] }[] = [];
    let groups: MemberGroup[] = [];
    try {
      groups = this.groupMembers();
    } catch {
      return out;
    }
    for (const g of groups) {
      if (!g.members.some((m) => m.p2pId === myId && m.identityKey === myKey)) continue;
      for (const m of g.members) {
        if (m.p2pId === myId || this.blocked.has(m.identityKey)) continue;
        try {
          if (p2pId(fromB64url(m.identityKey)) !== m.p2pId) continue;
        } catch {
          continue;
        }
        if (out.length < MAX_MEMBER_SUBS) out.push({ gid: g.gid, member: m });
      }
    }
    return out;
  }

  /** The groups where both of us are in the current record (checked again at every use). */
  private sharedGroups(identityKey: string): string[] {
    return [...new Set(this.memberLinks().filter((l) => l.member.identityKey === identityKey).map((l) => l.gid))].sort();
  }

  // ---- sender side: my invites ----------------------------------------------------------------------

  private async currentInvite(id: string): Promise<InviteRecord | undefined> {
    return (await loadInvites()).find((i) => i.id === id);
  }

  private async onInviteMessage(inviteId: string, content: string): Promise<void> {
    const inv = await this.currentInvite(inviteId);
    if (!inv || !this.pool) return;
    const boxId = fromHex(inv.id);
    let opened: { sealPub: Uint8Array; plain: Uint8Array };
    try {
      opened = await openBox(inv.boxSecret, boxId, fromB64url(content));
    } catch {
      return; // not for this invite
    }
    const text = fromUtf8(opened.plain);
    const open = inv.status === 'waiting' && Date.now() <= inv.expires;

    // Requests by ID always go through Accept / Block (no live connection before that).
    if (text.startsWith('P2P1.') && inv.kind === 'id') return;
    if (text.startsWith('P2P1.')) {
      // Live path: they opened the link while I'm online.
      let who: string;
      try {
        who = toB64url(verifyCode(await decodeCode(text), 'offer', `box:${inv.id}`).identityKey);
      } catch {
        return;
      }
      if (inv.blocked.includes(who) || this.blocked.has(who)) return;
      // The person who used it may try again (automatic retry, page reload): answer them again.
      // Not someone I deleted (Delete chat): they ask again through a new invite or my ID, and I choose.
      const again = inv.status === 'used' && who === inv.usedById && (await this.isContactKey(who));
      if (!open && !again) {
        const why = inv.status === 'waiting' ? 'expired' : 'used';
        if (who !== inv.usedById || inv.status === 'used') await this.liveReply(inv, opened.sealPub, { ok: false, why });
        return;
      }
      const seal = `live:${inv.id}:${toB64url(opened.sealPub)}`;
      if (this.handled.has(seal) || (!again && this.handled.has(`live:${inv.id}`) && this.liveBy.get(inv.id) !== who)) return;
      this.handled.add(seal);
      this.handled.add(`live:${inv.id}`);
      this.liveBy.set(inv.id, who);
      let made: { peer: Peer; code: string };
      try {
        made = await Peer.reply(this.me, text, `box:${inv.id}`);
      } catch {
        this.handled.delete(seal);
        return;
      }
      made.peer.diag.relays = this.pool?.open() ?? [];
      const info = made.peer.peer!;
      if (!again) await this.markUsed(inv, info.name, toB64url(info.publicKey));
      await this.addContact(info.publicKey, info.name, inv.relays);
      this.requests.delete(`${inv.id}:${who}`);
      this.ev.peer(made.peer, `${info.name || 'Someone'} joined from your invite`);
      await this.liveReply(inv, opened.sealPub, { ok: true, code: made.code }, made.peer);
      this.ev.changed();
      return;
    }

    // Stored path: a contact request.
    let req: ContactRequest;
    try {
      req = JSON.parse(text) as ContactRequest;
    } catch {
      return;
    }
    if (!verifyRequest(inv.id, req) || inv.blocked.includes(req.k) || this.blocked.has(req.k)) return;
    const key = `${inv.id}:${req.k}`;
    if (!open) {
      if ((req.k !== inv.usedById || !(await this.isContactKey(req.k))) && !this.handled.has(`used:${key}`)) {
        this.handled.add(`used:${key}`);
        await this.storeReply(inv, fromB64url(req.rb), { t: 'used' });
      }
      return;
    }
    if (this.requests.has(key)) return;
    // Spam limits: a few requests per box per hour, and a cap on the waiting list.
    const hour = Math.floor(Date.now() / 3600_000);
    const count = this.boxCounts.get(inv.id);
    const n = count?.hour === hour ? count.n : 0;
    if (n >= REQUESTS_PER_BOX_HOUR || this.requests.size >= MAX_WAITING_REQUESTS) return;
    this.boxCounts.set(inv.id, { hour, n: n + 1 });
    this.requests.set(key, { invite: inv, req });
    this.ev.request(inv, req);
    this.ev.changed();
  }

  private async liveReply(inv: InviteRecord, sealPub: Uint8Array, msg: object, until?: Peer): Promise<void> {
    if (!this.pool) return;
    const blob = await sealReply(inv.boxSecret, fromHex(inv.id), sealPub, utf8(JSON.stringify(msg)));
    const stop = this.pool.repeat(replyTag(fromHex(inv.id)), toB64url(blob), 3000, until ? 120_000 : 15_000);
    until?.on('ready', stop).on('closed', stop);
  }

  private async storeReply(inv: InviteRecord, rbPub: Uint8Array, msg: BoxReply): Promise<void> {
    if (!this.pool) return;
    const sealed = await sealToBox({ boxKey: rbPub, boxId: fromHex(inv.id) }, utf8(JSON.stringify(msg)));
    await this.pool.store(replyBoxTag(rbPub), toB64url(sealed.blob), inv.expires);
  }

  private async markUsed(inv: InviteRecord, name: string, by: string): Promise<void> {
    await saveInvite({ ...inv, status: 'used', usedBy: name || 'someone', usedById: by });
  }

  private async addContact(publicKey: Uint8Array, name: string, relays: string[], replyBox?: string): Promise<Contact> {
    const c: Contact = {
      id: p2pId(publicKey),
      publicKey: toB64url(publicKey),
      name,
      lastSeen: Date.now(),
      emoji: emojiCode(publicKey),
      relays,
      replyBox,
    };
    await saveContact(c);
    return c;
  }

  /** "Accept": the invite is used; the acceptance waits on the relays for them. */
  async accept(key: string): Promise<Contact | null> {
    const item = this.requests.get(key);
    if (!item) return null;
    this.requests.delete(key);
    const inv = (await this.currentInvite(item.invite.id)) ?? item.invite;
    const { req } = item;
    if (inv.kind !== 'id') await this.markUsed(inv, req.n, req.k);
    const contact = await this.addContact(fromB64url(req.k), req.n, inv.relays, req.rb);
    const a = { k: toB64url(this.me.publicKey), n: this.me.name.slice(0, 40), rr: inv.relays.slice(0, 8) };
    const acceptance: Acceptance = { t: 'accept', ...a, g: toB64url(sign(this.me.secretKey, acceptBytes(inv.id, a, req.rb))) };
    // Anyone else's requests for this invite now get "already used" (an ID box takes many).
    const used: Uint8Array[] = [];
    for (const [k, other] of this.requests) {
      if (other.invite.id === inv.id && inv.kind !== 'id') {
        this.requests.delete(k);
        used.push(fromB64url(other.req.rb));
      }
    }
    // The contact is saved, so Accept is done. The replies wait on the relays in the background (storing
    // retries for up to a minute when relays are slow or down), so the screen never hangs on Accept.
    void (async () => {
      await this.storeReply(inv, fromB64url(req.rb), acceptance);
      for (const rb of used) await this.storeReply(inv, rb, { t: 'used' });
      await this.refresh();
    })().catch(() => {});
    this.ev.changed();
    return contact;
  }

  /** "Block": ignore this person for this invite. (Deleting their event from relays is left for later.) */
  async block(key: string): Promise<void> {
    const item = this.requests.get(key);
    if (!item) return;
    this.requests.delete(key);
    const inv = (await this.currentInvite(item.invite.id)) ?? item.invite;
    await saveInvite({ ...inv, blocked: [...inv.blocked, item.req.k] });
    if (inv.kind === 'id') {
      this.blocked.add(item.req.k);
      await addBlocked(item.req.k);
    }
    this.ev.changed();
  }

  // ---- "Findable by my ID" -----------------------------------------------------------------------

  private cardAt = 0;

  /** Is my ID card on (published while the app is open)? */
  async findable(): Promise<boolean> {
    return (await loadInvites()).some((i) => i.kind === 'id' && i.status === 'waiting');
  }

  /** On: a request box and a public card for my ID. Off: no more card (and the old ones are deleted, NIP-09). */
  async setFindable(on: boolean): Promise<void> {
    const box = (await loadInvites()).find((i) => i.kind === 'id');
    if (on) {
      if (box?.status === 'waiting') return;
      const boxSecret = x25519.utils.randomPrivateKey();
      const id = toHex(crypto.getRandomValues(new Uint8Array(16)));
      const relays = await this.relaysFor();
      await saveInvite({ id, link: '', boxSecret, created: Date.now(), expires: ID_BOX_EXPIRES, relays, status: 'waiting', blocked: [], kind: 'id' });
      if (box) await saveInvite({ ...box, status: 'cancelled' });
      this.cardAt = 0;
      await saveCardPublishedAt(0);
      await this.refresh();
    } else {
      if (box) await saveInvite({ ...box, status: 'cancelled' });
      const all = await loadPublished();
      const cards = all.filter((r) => r.what === 'card');
      if (cards.length && this.pool) await this.pool.deleteStored(cards);
      await savePublished(all.filter((r) => r.what !== 'card'));
      await this.refresh();
    }
    this.ev.changed();
  }

  private async publishCard(box: InviteRecord): Promise<void> {
    if (!this.pool) return;
    // Only when the last one is missing or about to expire (relays keep it 24 h), not on every open.
    const last = Math.max(this.cardAt, (await loadCardPublishedAt()) ?? 0);
    if (Date.now() - last < CARD_REPUBLISH_MS) {
      this.cardAt = last;
      return;
    }
    this.cardAt = Date.now();
    await saveCardPublishedAt(this.cardAt);
    // No name on the public card (security review M-6): only the key, the request box and relays.
    const card = makeIdCard(this.me.secretKey, this.me.publicKey, '', x25519.getPublicKey(box.boxSecret), box.id, box.relays);
    // Its own connection and throwaway Nostr key, never the pool that carries the contacts' reconnect
    // subscriptions (security review H-3): the relays can't tie the card to those filters by key or socket.
    const allowed = new Set(this.allowed());
    const own = new RelayPool(box.relays.filter((r) => allowed.has(r)));
    try {
      await own.connect(6000);
      await own.store(idCardTag(p2pId(this.me.publicKey)), JSON.stringify(card), Date.now() + 24 * 3600_000, 2, 60_000, 'card');
    } finally {
      own.close();
    }
  }

  /** Looks for someone's ID card (up to 8 s). Resolves with the newest valid card, or null. */
  async findById(id: string, waitMs = FIND_WAIT_MS): Promise<IdCard | null> {
    const relays = searchRelays();
    const pool = new RelayPool(relays);
    await pool.connect(6000);
    return new Promise((resolve) => {
      let best: IdCard | null = null;
      let grace: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        clearTimeout(limit);
        if (grace) clearTimeout(grace);
        pool.close();
        resolve(best);
      };
      const limit = setTimeout(done, waitMs);
      pool.subscribe({ kinds: [STORED_KIND], tags: [idCardTag(id)] }, (content) => {
        let c: IdCard | null = null;
        try {
          c = checkIdCard(id, JSON.parse(content));
        } catch {
          return;
        }
        if (!c || (best && best.ts >= c.ts)) return;
        best = c;
        grace ??= setTimeout(done, 800); // other relays may hold a newer one
      });
    });
  }

  /** "Send request" to a found ID: like an invite request, locked to their request box; Accept / Block once. */
  async requestById(card: IdCard, note = ''): Promise<InviteJoin> {
    const allowed = new Set(searchRelays());
    const asCard: Card = {
      kind: 'invite',
      name: card.n,
      identityKey: fromB64url(card.k),
      boxKey: fromB64url(card.rb),
      boxId: fromHex(card.bid),
      expires: Date.now() + 24 * 3600_000,
      relays: card.rr.filter((r) => allowed.has(r)).concat([...allowed].filter((r) => !card.rr.includes(r))).slice(0, 8),
    };
    const j = await joinInvite(this.me, asCard, [...allowed], note, { live: false });
    void this.refresh();
    return j;
  }

  /** Block an identity key (Report on a request): ignored everywhere from now on. */
  async blockKey(publicKey: string): Promise<void> {
    this.blocked.add(publicKey);
    await addBlocked(publicKey);
  }

  /** Someone I deleted is trying to reconnect: one request row, nothing answered until I accept. */
  private async onDeletedOffer(d: DeletedContact, pair: PairKeys, content: string): Promise<void> {
    if (this.againRequests.has(d.publicKey) || this.blocked.has(d.publicKey)) return;
    try {
      await openPairOffer(pair, this.me.secretKey, fromB64url(content));
    } catch {
      return; // my own offer (another device of mine), or not for me
    }
    if (this.againRequests.has(d.publicKey) || this.blocked.has(d.publicKey) || (await this.isContactKey(d.publicKey))) return;
    this.againRequests.set(d.publicKey, d);
    this.ev.changed();
  }

  /** "Accept" on "<name> wants to talk again": a contact again (a new contact: files ask first). */
  async acceptAgain(publicKey: string): Promise<Contact | null> {
    const d = this.againRequests.get(publicKey) ?? (await loadDeletedContacts()).find((x) => x.publicKey === publicKey);
    if (!d) return null;
    this.againRequests.delete(publicKey);
    const c = await this.addContact(fromB64url(publicKey), d.name, d.relays);
    await removeDeletedContact(publicKey);
    this.ev.changed();
    await this.refresh();
    return c;
  }

  /** "Block" on "<name> wants to talk again". */
  async blockAgain(publicKey: string): Promise<void> {
    this.againRequests.delete(publicKey);
    await this.blockKey(publicKey);
    await removeDeletedContact(publicKey);
    this.ev.changed();
    await this.refresh();
  }

  /** Is this identity key one of my contacts now? */
  private async isContactKey(publicKey: string): Promise<boolean> {
    return (await loadContacts()).some((c) => c.publicKey === publicKey);
  }

  /**
   * "Delete chat": forget a contact on this device, without blocking. Their reconnects are no longer
   * answered (no subscription for them); to talk again they send a new request (my ID, or a new
   * invite), which waits for Accept like anyone's.
   */
  async forgetContact(c: Contact): Promise<void> {
    await addDeletedContact(c); // who they were (no messages): a reconnect from them then asks first
    await deleteContact(c.id);
    this.ev.changed();
    await this.refresh();
  }

  /** Block a contact: forget them and ignore their reconnects and requests from now on. */
  async blockContact(c: Contact): Promise<void> {
    this.blocked.add(c.publicKey);
    await addBlocked(c.publicKey);
    await deleteContact(c.id);
    this.ev.changed();
    await this.refresh();
  }

  async cancelInvite(id: string): Promise<void> {
    const inv = await this.currentInvite(id);
    if (inv && inv.status === 'waiting') await saveInvite({ ...inv, status: 'cancelled' });
    for (const [k, r] of this.requests) if (r.invite.id === id) this.requests.delete(k);
    this.ev.changed();
  }

  // ---- receiver side: my pending requests ----------------------------------------------------------

  private async onPendingReply(p: PendingRecord, content: string): Promise<void> {
    let msg: BoxReply;
    try {
      msg = JSON.parse(fromUtf8((await openBox(p.replySecret, fromHex(p.inviteId), fromB64url(content))).plain)) as BoxReply;
    } catch {
      return;
    }
    if (this.handled.has(`pending:${p.id}`)) return;
    if (msg.t === 'used') {
      this.handled.add(`pending:${p.id}`);
      await deletePending(p.id);
      this.ev.refused(p);
      this.ev.changed();
      return;
    }
    if (msg.t !== 'accept' || msg.k !== p.publicKey || typeof msg.g !== 'string') return;
    if (typeof msg.n !== 'string' || msg.n.length > 40 || !okRelays(msg.rr)) return;
    if (!verify(fromB64url(msg.k), acceptBytes(p.inviteId, msg, toB64url(p.replyPub)), fromB64url(msg.g))) return;
    this.handled.add(`pending:${p.id}`);
    await deletePending(p.id);
    const allowed = new Set(this.allowed());
    const contact = await this.addContact(fromB64url(msg.k), msg.n || p.name, (msg.rr ?? []).filter((r) => allowed.has(r)).concat(p.relays));
    this.ev.accepted(contact);
    this.ev.changed();
    await this.refresh();
  }

  // ---- contacts: the live hello ------------------------------------------------------------------------

  private pairCache = new Map<string, PairKeys>();
  private pair(c: Contact): PairKeys {
    let k = this.pairCache.get(c.publicKey);
    if (!k) {
      k = pairKeys(this.me.secretKey, this.me.publicKey, fromB64url(c.publicKey));
      this.pairCache.set(c.publicKey, k);
    }
    return k;
  }

  /**
   * A contact's reconnect offer. Several devices of mine (same 24 words) may all answer it; the
   * contact takes the first answer that connects and then posts a locked "taken" note, so the other
   * devices end their attempt quietly (no error, no "connecting", no "busy").
   */
  private async onContactOffer(c: Contact, pair: PairKeys, content: string, gid?: string): Promise<void> {
    const pool = this.pool;
    if (!pool) return;
    // A group-member link: only while both of us are in that group's current signed record.
    if (gid && !this.sharedGroups(c.publicKey).includes(gid)) return;
    let opened: { ephPub: Uint8Array; plain: Uint8Array };
    try {
      opened = await openPairOffer(pair, this.me.secretKey, fromB64url(content));
    } catch {
      return; // my own offer to them (or another device of mine to them), or not for me
    }
    if (this.blocked.has(c.publicKey)) return;
    const text = fromUtf8(opened.plain);
    // An ICE restart for a connection that is up but stalled (BUG-8): answered even in a call with them.
    if (text.startsWith('{')) return this.onRescue(c, pair, opened.ephPub, text);
    if (!this.canTake(c.id)) return; // talking to someone else, or in a call with them right now
    if (this.connecting.has(c.id)) {
      // Both pressed Connect at once: the lower P2P ID keeps its own attempt.
      if (p2pId(this.me.publicKey) < c.id) return;
    }
    let made: { peer: Peer; code: string };
    try {
      made = await Peer.reply(this.me, text, bindOf(pair, gid));
    } catch {
      return;
    }
    if (toB64url(made.peer.peer!.publicKey) !== c.publicKey) return made.peer.close(); // not this contact
    const peer = made.peer;
    peer.memberOf = gid;
    peer.diag.kind = gid ? 'Group member link (I answered)' : 'Reconnect from a contact (I answered)';
    peer.diag.relays = pool.open();
    const attempt = toB64url(opened.ephPub);
    const myDevice = this.me.device ? toB64url(this.me.device.publicKey) : '';
    const blob = await sealPairReply(pair, opened.ephPub, utf8(JSON.stringify({ ok: true, code: made.code })));
    const stopReply = pool.repeat(pairSendTags(pair, 'reply')[0], toB64url(blob), 3000, 30_000);
    let over = false;
    const finish = () => {
      if (over) return;
      over = true;
      stopReply();
      unsubTaken();
      clearTimeout(giveUp);
    };
    const quietEnd = () => {
      finish();
      if (!peer.ready) peer.close();
    };
    const unsubTaken = pool.subscribe({ kinds: [SIGNAL_KIND], tags: pairTagsAround(pair.secret, 'taken') }, async (note) => {
      let msg: { t?: string; a?: string; d?: string };
      try {
        msg = JSON.parse(fromUtf8(await openPairNote(pair, fromB64url(note))));
      } catch {
        return;
      }
      if (msg.t !== 'taken' || msg.a !== attempt || peer.ready) return;
      if (myDevice && msg.d === myDevice) return; // this device won
      if (DEBUG) console.info('P2P Talk: another device of this account took this connection');
      quietEnd();
      this.ev.taken?.(c);
    });
    const giveUp = setTimeout(quietEnd, ANSWER_GIVE_UP_MS);
    // Only a connection that really opened reaches the screens (a losing device shows nothing).
    peer.on('ready', () => {
      finish();
      this.ev.peer(peer, '');
    }).on('closed', finish);
  }

  // ---- keeping connections through a network change (BUG-8) -----------------------------------------

  /**
   * My connection to a contact stalled and the chat channel may be down with it: carry its ICE
   * restart offer through the relays, locked like a reconnect offer (pair secret + their identity),
   * and addressed by both link fingerprints, so only that connection takes it.
   */
  private async sendRescue(p: Peer, offer: RTCSessionDescriptionInit): Promise<void> {
    const info = p.peer;
    const pool = this.pool;
    if (!info || !pool || !pool.open().length || !offer.sdp || this.rescuing.get(p) === offer.sdp) return;
    const theirKey = toB64url(info.publicKey);
    if (this.blocked.has(theirKey)) return;
    this.rescuing.set(p, offer.sdp);
    const pair = p.memberOf ? this.memberPair(theirKey, p.memberOf) : this.pair({ publicKey: theirKey } as Contact);
    const fp = p.fingerprints;
    const sealed = await sealPairOffer(pair, info.publicKey, utf8(JSON.stringify({ t: 'ice', to: fp.theirs, from: fp.mine, d: offer })));
    let over = false;
    const end = () => {
      if (over) return;
      over = true;
      unsub();
      stops.forEach((s) => s());
      clearTimeout(timer);
      p.off('link', onLink).off('closed', end);
      sealed.ephSecret.fill(0);
    };
    const onLink = (st: 'up' | 'reconnecting') => st === 'up' && end();
    const unsub = pool.subscribe({ kinds: [SIGNAL_KIND], tags: pairListenTags(pair, 'reply') }, async (content) => {
      if (over) return;
      let msg: { t?: string; d?: RTCSessionDescriptionInit };
      try {
        msg = JSON.parse(fromUtf8(await openPairReply(pair, sealed.ephSecret, fromB64url(content))));
      } catch {
        return; // not for this offer
      }
      if (msg.t !== 'ice' || !msg.d) return;
      await p.rescueAnswer(msg.d, offer.sdp!).catch(() => undefined);
    });
    const stops = pairSendTags(pair, 'offer').map((tag) => pool.repeat(tag, toB64url(sealed.blob), 3000, RESCUE_MS));
    const timer = setTimeout(end, RESCUE_MS + 2000);
    p.on('link', onLink).on('closed', end);
    if (DEBUG) console.info('P2P Talk: ICE restart offer through the relays');
  }

  /** Their ICE restart offer through the relays: give it to that connection, and post its answer back. */
  private async onRescue(c: Contact, pair: PairKeys, ephPub: Uint8Array, text: string): Promise<void> {
    const pool = this.pool;
    const key = `rescue:${toB64url(ephPub)}`;
    if (!pool || this.handled.has(key)) return;
    let msg: { t?: string; to?: string; from?: string; d?: RTCSessionDescriptionInit };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.t !== 'ice' || typeof msg.to !== 'string' || typeof msg.from !== 'string' || !msg.d) return;
    const p = findPeer(msg.to, msg.from);
    if (!p?.peer || toB64url(p.peer.publicKey) !== c.publicKey) return; // not a connection of mine with them
    this.handled.add(key);
    const answer = await p.rescueOffer(msg.d).catch(() => null);
    if (!answer) return;
    const blob = await sealPairReply(pair, ephPub, utf8(JSON.stringify({ t: 'ice', d: answer })));
    const stop = pool.repeat(pairSendTags(pair, 'reply')[0], toB64url(blob), 3000, RESCUE_MS);
    const done = (st?: string) => {
      if (st && st !== 'up') return;
      stop();
      p.off('link', done).off('closed', done);
    };
    p.on('link', done).on('closed', done);
  }

  /** A connection to a contact was lost by itself (not closed by the app): make it again, quietly. */
  private async reconnectLost(p: Peer): Promise<void> {
    const key = p.peer ? toB64url(p.peer.publicKey) : '';
    if (!key || this.blocked.has(key) || this.reconnecting.has(key)) return;
    this.reconnecting.add(key);
    try {
      for (const wait of RECONNECT_AFTER_MS) {
        await new Promise((r) => setTimeout(r, wait));
        if (hasLivePeer(key) || !this.timer) return; // they reconnected first, or the app stopped
        const c = (await loadContacts()).find((x) => x.publicKey === key);
        if (!c || this.blocked.has(key)) return;
        if (!this.canTake(c.id) || this.connecting.has(c.id)) continue;
        let peer: Peer | undefined;
        try {
          peer = await this.connectTo(c);
          await peer.whenReady();
          if (DEBUG) console.info('P2P Talk: reconnected quietly');
          this.ev.peer(peer, '');
          return;
        } catch {
          // Offline for now: try again after the next pause. An answered attempt that never opened is
          // closed here, or it would stay alive unseen (and could become ready later with nobody listening).
          peer?.close();
        }
      }
    } finally {
      this.reconnecting.delete(key);
    }
  }

  /** After my reconnect connected: tell all of their devices which attempt was taken, and by which device. */
  private async sayTaken(pair: PairKeys, ephPub: Uint8Array, peer: Peer): Promise<void> {
    const pool = this.pool;
    if (!pool) return;
    const note = { t: 'taken', a: toB64url(ephPub), d: peer.peer?.device?.key ?? '' };
    const blob = await sealPairNote(pair, utf8(JSON.stringify(note)));
    for (const tag of pairSendTags(pair, 'taken')) pool.repeat(tag, toB64url(blob), 3000, TAKEN_MS);
  }

  /** "Connect" to a contact. Resolves with the connection, or rejects after 8 s with no answer. */
  async connectTo(c: Contact, waitMs = CONTACT_WAIT_MS): Promise<Peer> {
    await this.refresh();
    const isContact = (await loadContacts()).some((x) => x.publicKey === c.publicKey);
    const gid = this.sharedGroups(c.publicKey)[0];
    if (!isContact && gid) return this.connectVia(c, this.memberPair(c.publicKey, gid), waitMs, gid);
    try {
      return await this.connectVia(c, this.pair(c), waitMs);
    } catch (e) {
      // A contact who doesn't have me as a contact (deleted me) but shares a group: as a member.
      if (!gid || e instanceof RelaysUnreachable) throw e;
      return this.connectVia(c, this.memberPair(c.publicKey, gid), waitMs, gid);
    }
  }

  private async connectVia(c: Contact, pair: PairKeys, waitMs: number, gid?: string): Promise<Peer> {
    const pool = this.pool;
    if (!pool || !pool.open().length) throw new RelaysUnreachable();
    const theirKey = fromB64url(c.publicKey);
    const made = await Peer.start(this.me, bindOf(pair, gid));
    made.peer.memberOf = gid;
    made.peer.diag.kind = gid ? 'Group member link (I made the offer)' : 'Reconnect to a contact (I made the offer)';
    made.peer.diag.relays = pool.open();
    const sealed = await sealPairOffer(pair, theirKey, utf8(made.code));
    this.connecting.add(c.id);
    return new Promise<Peer>((resolve, reject) => {
      let settled = false;
      const end = (err?: Error) => {
        if (settled) return;
        settled = true;
        stop();
        unsub();
        clearTimeout(timer);
        sealed.ephSecret.fill(0);
        this.connecting.delete(c.id);
        if (err) {
          made.peer.close();
          reject(err);
        } else resolve(made.peer);
      };
      // First answer wins: their other devices may answer too; later answers are ignored quietly.
      let taking = false;
      const unsub = pool.subscribe({ kinds: [SIGNAL_KIND], tags: pairListenTags(pair, 'reply') }, async (content) => {
        if (taking || settled) return;
        let msg: { ok: boolean; code: string };
        try {
          msg = JSON.parse(fromUtf8(await openPairReply(pair, sealed.ephSecret, fromB64url(content))));
        } catch {
          return; // not for this attempt
        }
        if (!msg.ok || taking || settled) return;
        taking = true;
        try {
          await made.peer.finish(msg.code, theirKey);
          made.peer.on('ready', () => void this.sayTaken(pair, sealed.ephPub, made.peer));
          end();
        } catch {
          taking = false; // a bad answer: keep waiting for a good one
        }
      });
      // Posted to their inbox tag (H-3), plus the old shared tag while older versions are around.
      const stops = pairSendTags(pair, 'offer').map((tag) => pool.repeat(tag, toB64url(sealed.blob), 3000, waitMs));
      const stop = () => stops.forEach((s) => s());
      const timer = setTimeout(() => end(new Error(`${c.name || c.id} is offline · try again later`)), waitMs);
    });
  }
}

// ---- receiver side: opening an invite link ----------------------------------------------------------

export interface InviteJoin {
  /** Live answer: connected (A was online). */
  connected: Promise<Peer>;
  /** The stored request reached the relays and nobody answered live in time. */
  requestSent: Promise<void>;
  /** "already used" (live or stored reply). */
  refused: Promise<void>;
  cancel(): void;
}

export async function joinInvite(me: Me, card: Card, allowed: string[], note = '', opts: { live?: boolean } = {}): Promise<InviteJoin> {
  if (card.kind !== 'invite') throw new CardError('Not an invite.');
  if (p2pId(card.identityKey) === p2pId(me.publicKey)) throw new CardError('This is your own invite.');
  const live = opts.live !== false;
  const relays = card.relays.filter((r) => allowed.includes(r));
  if (!relays.length) throw new RelaysUnreachable();
  const pool = new RelayPool(relays);
  const [connectedRelays, made] = await Promise.all([pool.connect(6000), live ? Peer.start(me, `box:${toHex(card.boxId)}`) : Promise.resolve(null)]);
  if (made) {
    made.peer.diag.kind = 'Opening an invite (I made the offer)';
    made.peer.diag.relays = connectedRelays;
  }
  if (!connectedRelays.length) {
    pool.close();
    made?.peer.close();
    throw new RelaysUnreachable();
  }

  // My reply box: where their acceptance (or "already used") will wait for me.
  const replySecret = x25519.utils.randomPrivateKey();
  const replyPub = x25519.getPublicKey(replySecret);
  const pending: PendingRecord = {
    id: p2pId(card.identityKey),
    publicKey: toB64url(card.identityKey),
    name: card.name,
    inviteId: toHex(card.boxId),
    replySecret,
    replyPub,
    relays: connectedRelays,
    sentAt: Date.now(),
    expires: card.expires,
  };
  await savePending(pending);

  const body = { k: toB64url(me.publicKey), n: me.name.slice(0, 40), note: note.slice(0, 140), rb: toB64url(replyPub), rr: connectedRelays.slice(0, 8), ts: Date.now() };
  const req: ContactRequest = { t: 'req', ...body, g: toB64url(sign(me.secretKey, reqBytes(pending.inviteId, body))) };
  const sealedReq = await sealToBox(card, utf8(JSON.stringify(req)));

  let refuse: () => void = () => {};
  const refused = new Promise<void>((r) => (refuse = r));

  // Live path, in case they are online now.
  const sealedOffer = made ? await sealToBox(card, utf8(made.code)) : null;
  let stopLive = () => {};
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  const connected = new Promise<Peer>((resolve) => {
    if (!made || !sealedOffer) return; // a request by ID: no live connection before Accept
    pool.subscribe(replyTag(card.boxId), async (content) => {
      try {
        const msg = JSON.parse(fromUtf8(await openReply(sealedOffer.sealSecret, card, fromB64url(content)))) as
          | { ok: true; code: string }
          | { ok: false };
        clearTimeout(slowTimer);
        stopLive();
        if (!msg.ok) {
          made.peer.close();
          await deletePending(pending.id);
          refuse();
          return;
        }
        await made.peer.finish(msg.code, card.identityKey);
        await deletePending(pending.id);
        resolve(made.peer);
      } catch {
        /* not for us */
      }
    });
    // Quickly at first. Then, while this page stays open, keep offering slowly until the invite
    // expires: if they come online while I'm still here we connect straight away, without
    // Accept / Block (Dr Vijay, 22 Oct 2026). If I've gone, the stored request (and their Accept) takes over.
    stopLive = pool.repeat(offerTag(card.boxId), toB64url(sealedOffer.blob), 3000, LIVE_WAIT_MS - 1000);
    slowTimer = setTimeout(() => {
      stopLive = pool.repeat(offerTag(card.boxId), toB64url(sealedOffer.blob), SLOW_OFFER_MS, Math.max(0, card.expires - Date.now()));
    }, LIVE_WAIT_MS);
  });

  // Stored path: the request waits on the relays (until the invite expires, at most 24 h).
  const stored = pool.store(offerTag(card.boxId), toB64url(sealedReq.blob), card.expires, 2, 60_000, 'request');
  const requestSent = (async () => {
    const [ok] = await Promise.all([stored, new Promise((r) => setTimeout(r, LIVE_WAIT_MS + 1000))]);
    if (!ok) throw new RelaysUnreachable();
  })();

  return {
    connected,
    requestSent,
    refused,
    cancel: () => {
      clearTimeout(slowTimer);
      stopLive();
      pool.close();
      made?.peer.close();
    },
  };
}

export { INVITE_USED_TEXT };
