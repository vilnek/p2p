// Group calls (plan §8.4, Phase 2): a small FULL MESH, no server, no media relay.
//
// One RTCPeerConnection per PAIR of people in the call; each person sends their microphone and
// camera to every other one directly. Up to 8 people on voice, 6 on video (upload is the limit:
// n − 1 copies of my own video). Design: docs/INTEGRATION_FILES_GROUPS.md §3.7 and §5.
//
// Signalling   Every frame (`gc-*`) is JSON, signed with Ed25519 by the sender's identity key, and
//   travels over the pair's existing LOCKED 1:1 chat channel (`send(toId, frame)`), or for an invite
//   to someone not reachable, through the group's fan-out (`fanout`, a locked group message). A frame
//   only counts when: the group is one I have joined, the sender is in the CURRENT signed member list,
//   the channel it came on is the sender's own (`from` = channel peer), it is for me, and the
//   signature checks with the sender's identity key from that signed member list.
//
// Each pair    Checked like a 1:1 call: the DTLS fingerprint in every offer / answer is signed by
//   the sender's identity key (field `fp`, checked against the SDP), and it may not change for the
//   life of that connection. Who offers: the LOWER P2P ID of the two (no glare); glare that still
//   happens (both sides restarting at once) is solved with the "perfect negotiation" rule (the
//   higher ID is polite). Each connection is set up once with an audio and a video transceiver, so
//   camera on / off, a voice call turning to video and screen sharing are only replaceTrack (no
//   renegotiation).
//
// Flow         start(gid) → gc-invite to each member → gc-ring (their device rings) → join(cid) sends
//   gc-join to everyone in the call (from the invite's list) → each one answers gc-roster (who else is
//   in) → pairs connect. decline(cid) → gc-decline; busy → gc-busy; a full call → gc-full. leave() →
//   gc-leave to all; the call ends for me when nobody else is in it or ringing; the last one out sends
//   gc-end to members still ringing. A late joiner (missed, declined, came online later, or rejoining
//   after leaving) uses the same join path while the call runs.

import { exactly, openChosen } from '../core/mediaDevices';
import { fromB64url, toB64url, utf8 } from '../core/bytes';
import { p2pId, sign, verify } from '../core/identity';
import { pathFromStats, type PathInfo } from '../core/path';
import { sdpFingerprint } from '../core/signal';

/** Sent in the hello by builds that take part in group calls. */
/** My camera and microphone in a group call (small mesh: modest video). */
const CAMERA: MediaTrackConstraints = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } };
const SOUND: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

export const GROUP_CALL_FEATURE = 'gcall1';
/** Frame kinds this module handles: route these from the locked chat channel to `onFrame`. */
export const GROUP_CALL_KINDS = new Set([
  'gc-invite',
  'gc-ring',
  'gc-join',
  'gc-decline',
  'gc-busy',
  'gc-full',
  'gc-roster',
  'gc-sdp',
  'gc-ice',
  'gc-leave',
  'gc-end',
  'gc-media',
  'gc-screen',
]);
const LABEL = 'p2ptalk-gcall-v1';

/** Most people in one call (me included). */
export const MAX_VOICE = 8;
export const MAX_VIDEO = 6;
/** Opus, per outgoing copy. */
export const AUDIO_MAX_BITRATE = 32_000;
/**
 * Video per outgoing copy, by how many people are in the call (me included). Up to 4 at full
 * quality; above 4 the bitrate (and the picture size) steps down so n − 1 copies still fit an upload.
 */
export const VIDEO_STEPS: readonly { upTo: number; maxBitrate: number; scale: number }[] = [
  { upTo: 4, maxBitrate: 1_500_000, scale: 1 },
  { upTo: 5, maxBitrate: 600_000, scale: 1.5 },
  { upTo: Infinity, maxBitrate: 300_000, scale: 2 },
];
export const videoStep = (people: number) => VIDEO_STEPS.find((s) => people <= s.upTo) ?? VIDEO_STEPS[VIDEO_STEPS.length - 1];
export const maxPeople = (video: boolean) => (video ? MAX_VIDEO : MAX_VOICE);

/** Same as peer.ts: public STUN only, no TURN, no relay. */
const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
/** inbound-rtp audioLevel (0..1) above which someone counts as speaking. */
const SPEAK_LEVEL = 0.03;
const SPEAK_HOLD_MS = 900;

// ---- types --------------------------------------------------------------------------------------------

export type ParticipantState = 'reaching' | 'ringing' | 'connecting' | 'connected' | 'failed' | 'left';
/** offline: not reachable · no-answer · declined · busy (in another call) · media: the sound/video connection failed · full · removed from the group. */
export type ParticipantReason = 'offline' | 'no-answer' | 'declined' | 'busy' | 'media' | 'full' | 'removed';

export interface Participant {
  id: string;
  name: string;
  state: ParticipantState;
  reason?: ParticipantReason;
  /** Their sound and video (null until the connection is set up). */
  stream: MediaStream | null;
  /** Their video is really arriving (else show their initial). */
  hasVideo: boolean;
  /** Speaking now (from the audio level). */
  speaking: boolean;
  /** What they told us: microphone on, camera on, sharing their screen. */
  mic: boolean;
  camera: boolean;
  screen: boolean;
  /** The pair's path (direct / same Wi-Fi), for the badge on the tile. */
  path?: PathInfo;
}

/** incoming: rings on my device · joined: I am in it · missed / declined: I didn't join (late join still possible) · ended. */
export type GroupCallState = 'incoming' | 'joined' | 'missed' | 'declined' | 'ended';
export type GroupCallEndReason = 'left' | 'everyone-left' | 'removed' | 'full';

export interface GroupCallInfo {
  callId: string;
  gid: string;
  groupName: string;
  video: boolean;
  state: GroupCallState;
  /** Who started it (or who rang me). */
  by: string;
  byName: string;
  reason?: GroupCallEndReason;
  /** The call is still running and I am not in it: show "Join" (also after missing or declining it). */
  canJoin: boolean;
}

export interface GroupCallEvents {
  /** Someone in the call changed state, stream, mute, speaking or path. */
  participant(p: Participant): void;
  /** My call changed (incoming, joined, ended …). */
  call(c: GroupCallInfo): void;
  /** A new incoming group call: "Ravi is calling Seva team · Join / Decline". */
  invite(c: GroupCallInfo): void;
  /** The active speaker (the big tile); null before anyone spoke. */
  speaker(id: string | null): void;
  /** Who shares their screen now (my own ID when it is me), or null. */
  screen(by: string | null): void;
  /** My own camera / microphone (null after the call). */
  localStream(s: MediaStream | null): void;
}

/** The little the module needs from a group (GroupManager fits it). */
export interface GroupMemberLike {
  p2pId: string;
  identityKey: string;
  name: string;
}
export interface GroupSource {
  record(gid: string): { id: string; name: string; members: GroupMemberLike[] } | undefined;
  get(gid: string): { status: string; name: string } | undefined;
  on?(k: 'group' | 'removed', fn: (g: { id: string }) => void): () => void;
}

export interface GroupCallOptions {
  me: { secretKey: Uint8Array; publicKey: Uint8Array; name: string };
  groups: GroupSource;
  /** Send a frame over the LOCKED 1:1 chat channel to this person. Rejects when not connected. */
  send(toId: string, frame: GroupCallFrame): Promise<void>;
  /** Connect to a member now (hub.connectTo). Rejects when they can't be reached. */
  connect?(toId: string): Promise<void>;
  /** Carry an invite through the group (a locked group message) to members I can't reach. */
  fanout?(gid: string, frame: GroupCallFrame): Promise<void>;
  /** True while a 1:1 call is on (then incoming group calls answer "busy"). */
  busy?(): boolean;
  createPeerConnection?(config: RTCConfiguration): RTCPeerConnection;
  getUserMedia?(c: MediaStreamConstraints): Promise<MediaStream>;
  getDisplayMedia?(): Promise<MediaStream>;
  newStream?(): MediaStream;
  iceServers?: RTCIceServer[];
  /** How long an invite rings (45 s). */
  ringMs?: number;
  /** No ring back after the invite went out: "offline" (8 s). */
  reachMs?: number;
  /** A joined pair must have sound / video within this (25 s), else "media". */
  mediaMs?: number;
  /** Waiting for connect() (15 s). */
  connectMs?: number;
  /** How often audio levels and paths are read (400 ms; 0 = off). */
  pollMs?: number;
  now?(): number;
}

interface RosterEntry {
  id: string;
  sid: string;
}

export type GroupCallKind =
  | 'gc-invite'
  | 'gc-ring'
  | 'gc-join'
  | 'gc-decline'
  | 'gc-busy'
  | 'gc-full'
  | 'gc-roster'
  | 'gc-sdp'
  | 'gc-ice'
  | 'gc-leave'
  | 'gc-end'
  | 'gc-media'
  | 'gc-screen';

/** One signalling frame (all signed; `to` is '' only for an invite carried by the group, and gc-end). */
export interface GroupCallFrame {
  k: GroupCallKind;
  cid: string;
  gid: string;
  from: string;
  to: string;
  ts: number;
  sig: string;
  video?: boolean;
  /** Who is in the call (invite, roster, leave), with each one's session id. */
  in?: RosterEntry[];
  /** Members still ringing (roster, leave). */
  ringing?: string[];
  /** The sender's session (one per join) and the session it is meant for. */
  sid?: string;
  rsid?: string;
  d?: { type: 'offer' | 'answer'; sdp: string };
  /** The DTLS fingerprint of `d.sdp`, signed with the rest. */
  fp?: string;
  c?: RTCIceCandidateInit | null;
  on?: boolean;
  /** gc-screen: when that person started sharing (the earlier one wins when two start at once). */
  at?: number;
  mic?: boolean;
  cam?: boolean;
}

interface Part {
  id: string;
  name: string;
  state: ParticipantState;
  reason?: ParticipantReason;
  sid: string;
  pc: RTCPeerConnection | null;
  fp: string;
  stream: MediaStream | null;
  ice: RTCIceCandidateInit[];
  makingOffer: boolean;
  ignoreOffer: boolean;
  offeredFor: string;
  restarted: boolean;
  timer?: ReturnType<typeof setTimeout>;
  level: number;
  lastLoud: number;
  speaking: boolean;
  mic: boolean;
  camera: boolean;
  screen: boolean;
  path?: PathInfo;
  step: string;
}

interface Call {
  cid: string;
  gid: string;
  video: boolean;
  by: string;
  state: GroupCallState;
  reason?: GroupCallEndReason;
  /** Who is said to be in it (invite / roster / leave hints): id → session. */
  known: Map<string, string>;
  /** Who rang me (decline goes to them). */
  inviters: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
  /** When I left: who was still in (for late joiners who ask me). */
  lastRoster?: RosterEntry[];
  lastRinging?: string[];
  fannedOut?: boolean;
  /** Someone told me it is over (gc-end): no joining any more. */
  over?: boolean;
  at: number;
}

// ---- signing --------------------------------------------------------------------------------------------

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) o[k] = canon(x);
    }
    return o;
  }
  return v;
}

/** The exact bytes signed: JSON[label, the frame without `sig`, keys sorted]. */
export function frameBytes(f: GroupCallFrame): Uint8Array {
  const { sig: _sig, ...rest } = f;
  return utf8(JSON.stringify([LABEL, canon(rest)]));
}

const randomId = () => toB64url(crypto.getRandomValues(new Uint8Array(9)));
const isStr = (s: unknown, max: number): s is string => typeof s === 'string' && s.length <= max;
const isId = (s: unknown): s is string => typeof s === 'string' && /^\d{24}$/.test(s);
const LIVE: ParticipantState[] = ['connecting', 'connected'];
const PENDING: ParticipantState[] = ['reaching', 'ringing', 'connecting', 'connected'];

function rosterOk(r: unknown): r is RosterEntry[] {
  return Array.isArray(r) && r.length <= 16 && r.every((e) => e && typeof e === 'object' && isId((e as RosterEntry).id) && isStr((e as RosterEntry).sid, 40));
}

/** Cheap shape checks before anything else (frames come from other people). */
function shapeOk(f: GroupCallFrame): boolean {
  if (!f || typeof f !== 'object' || !GROUP_CALL_KINDS.has(f.k)) return false;
  if (!isStr(f.cid, 40) || !f.cid || !isStr(f.gid, 64) || !isId(f.from) || !(f.to === '' || isId(f.to))) return false;
  if (typeof f.ts !== 'number' || !Number.isFinite(f.ts) || !isStr(f.sig, 100)) return false;
  if (f.in !== undefined && !rosterOk(f.in)) return false;
  if (f.ringing !== undefined && !(Array.isArray(f.ringing) && f.ringing.length <= 16 && f.ringing.every(isId))) return false;
  if (f.sid !== undefined && !isStr(f.sid, 40)) return false;
  if (f.rsid !== undefined && !isStr(f.rsid, 40)) return false;
  if (f.k === 'gc-sdp' && !(f.d && (f.d.type === 'offer' || f.d.type === 'answer') && isStr(f.d.sdp, 200_000) && isStr(f.fp, 200))) return false;
  if (f.k === 'gc-ice' && !(f.c === null || (f.c && typeof f.c === 'object' && isStr(f.c.candidate ?? '', 2000)))) return false;
  return true;
}

// ---- the manager ----------------------------------------------------------------------------------------

export class GroupCallManager {
  readonly myId: string;
  private readonly o: GroupCallOptions;
  private readonly t: { ringMs: number; reachMs: number; mediaMs: number; connectMs: number; pollMs: number };
  private readonly listeners = new Map<keyof GroupCallEvents, Set<(...a: never[]) => void>>();
  private readonly calls = new Map<string, Call>();
  private readonly parts = new Map<string, Part>();
  private cur: Call | null = null;
  private sid = '';
  private work: Promise<void> = Promise.resolve();
  private readonly outq = new Map<string, Promise<boolean>>();
  private readonly connecting = new Map<string, Promise<boolean>>();
  private readonly connectFailedAt = new Map<string, number>();
  private readonly unsub: (() => void)[] = [];
  private poll: ReturnType<typeof setInterval> | undefined;

  // my media
  private local: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private camTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private extraAudio: MediaStreamTrack | null = null;
  private micOn = true;
  private camOn = false;
  private sharer: { id: string; ts: number } | null = null;
  private speakerId: string | null = null;

  constructor(opts: GroupCallOptions) {
    this.o = opts;
    this.myId = p2pId(opts.me.publicKey);
    this.t = {
      ringMs: opts.ringMs ?? 45_000,
      reachMs: opts.reachMs ?? 8_000,
      mediaMs: opts.mediaMs ?? 25_000,
      connectMs: opts.connectMs ?? 15_000,
      pollMs: opts.pollMs ?? 400,
    };
    const g = opts.groups;
    if (g.on) {
      this.unsub.push(g.on('group', (x) => void this.run(async () => this.onGroupChanged(x.id))));
      this.unsub.push(g.on('removed', (x) => void this.run(async () => this.onGroupChanged(x.id))));
    }
  }

  // ---- events -----------------------------------------------------------------------------------------

  on<K extends keyof GroupCallEvents>(k: K, fn: GroupCallEvents[K]): () => void {
    const set = this.listeners.get(k) ?? new Set();
    set.add(fn as (...a: never[]) => void);
    this.listeners.set(k, set);
    return () => set.delete(fn as (...a: never[]) => void);
  }

  private emit<K extends keyof GroupCallEvents>(k: K, ...a: Parameters<GroupCallEvents[K]>): void {
    for (const fn of [...(this.listeners.get(k) ?? [])]) {
      try {
        (fn as (...x: unknown[]) => void)(...a);
      } catch (e) {
        console.warn('P2P Talk: group call listener', e);
      }
    }
  }

  /** Resolves when every frame and action so far has been handled (tests). */
  idle(): Promise<void> {
    return this.work;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.work.then(fn);
    this.work = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  // ---- reading state ----------------------------------------------------------------------------------

  /** The call I am in (or null). */
  get call(): GroupCallInfo | null {
    return this.cur && this.info(this.cur);
  }

  get inCall(): boolean {
    return !!this.cur;
  }

  /** Calls ringing or still running that I could join (incoming, missed, declined, or one I left). */
  joinable(gid?: string): GroupCallInfo[] {
    return [...this.calls.values()]
      .filter((c) => (!gid || c.gid === gid) && this.canJoin(c))
      .map((c) => this.info(c));
  }

  private canJoin(c: Call): boolean {
    if (c === this.cur || c.over) return false;
    return c.state === 'incoming' || c.state === 'missed' || c.state === 'declined' || (c.state === 'ended' && c.reason === 'left' && !!c.lastRoster?.length);
  }

  participants(): Participant[] {
    return [...this.parts.values()].map((p) => this.snap(p));
  }

  get localStream(): MediaStream | null {
    return this.local;
  }

  get mic(): boolean {
    return this.micOn;
  }

  get camera(): boolean {
    return this.camOn;
  }

  /** Who shares their screen (my ID when I do), or null. */
  get screenBy(): string | null {
    return this.sharer?.id ?? null;
  }

  get speaker(): string | null {
    return this.speakerId;
  }

  private info(c: Call): GroupCallInfo {
    const rec = this.o.groups.record(c.gid);
    return {
      callId: c.cid,
      gid: c.gid,
      groupName: rec?.name ?? this.o.groups.get(c.gid)?.name ?? '',
      video: c.video,
      state: c.state,
      by: c.by,
      byName: c.by === this.myId ? this.o.me.name : (rec?.members.find((m) => m.p2pId === c.by)?.name ?? ''),
      reason: c.reason,
      canJoin: this.canJoin(c),
    };
  }

  private snap(p: Part): Participant {
    const hasVideo = !!p.stream?.getVideoTracks().some((t) => !t.muted && t.readyState !== 'ended');
    return {
      id: p.id,
      name: p.name,
      state: p.state,
      reason: p.reason,
      stream: p.stream,
      hasVideo,
      speaking: p.speaking,
      mic: p.mic,
      camera: p.camera,
      screen: p.screen,
      path: p.path,
    };
  }

  private emitPart(p: Part): void {
    if (this.parts.get(p.id) === p) this.emit('participant', this.snap(p));
  }

  private emitCall(c: Call): void {
    this.emit('call', this.info(c));
  }

  // ---- membership -------------------------------------------------------------------------------------

  /** The current signed member list, if I have joined the group. */
  private roster(gid: string): GroupMemberLike[] | undefined {
    if (this.o.groups.get(gid)?.status !== 'joined') return undefined;
    const rec = this.o.groups.record(gid);
    if (!rec || !rec.members.some((m) => m.p2pId === this.myId)) return undefined;
    return rec.members;
  }

  private member(gid: string, id: string): GroupMemberLike | undefined {
    return this.roster(gid)?.find((m) => m.p2pId === id);
  }

  private onGroupChanged(gid: string): void {
    const members = this.roster(gid);
    for (const c of this.calls.values()) {
      if (c.gid !== gid || c === this.cur || c.state === 'ended') continue;
      if (!members) this.setCallState(c, 'ended', 'removed');
    }
    const cur = this.cur;
    if (!cur || cur.gid !== gid) return;
    if (!members) {
      this.leaveNow('removed');
      return;
    }
    for (const p of [...this.parts.values()]) {
      if (members.some((m) => m.p2pId === p.id)) continue;
      this.closePair(p);
      this.setPart(p, 'left', 'removed');
    }
    this.checkEnd();
  }

  // ---- sending ----------------------------------------------------------------------------------------

  private frame(k: GroupCallKind, c: Call, to: string, extra: Partial<GroupCallFrame> = {}): GroupCallFrame {
    const f = { k, cid: c.cid, gid: c.gid, from: this.myId, to, ts: (this.o.now ?? Date.now)(), ...extra, sig: '' } as GroupCallFrame;
    f.sig = toB64url(sign(this.o.me.secretKey, frameBytes(f)));
    return f;
  }

  /** Sends in order per person; on failure connects once (if allowed) and tries again. */
  private post(to: string, f: GroupCallFrame, tryConnect = true): Promise<boolean> {
    const prev = this.outq.get(to) ?? Promise.resolve(true);
    const p = prev.then(async () => {
      try {
        await this.o.send(to, f);
        return true;
      } catch {
        /* not connected */
      }
      if (!tryConnect || !(await this.reach(to))) return false;
      try {
        await this.o.send(to, f);
        return true;
      } catch {
        return false;
      }
    });
    this.outq.set(
      to,
      p.catch(() => false),
    );
    return p;
  }

  private reach(to: string): Promise<boolean> {
    if (!this.o.connect) return Promise.resolve(false);
    const failed = this.connectFailedAt.get(to);
    if (failed !== undefined && Date.now() - failed < 5000) return Promise.resolve(false);
    let p = this.connecting.get(to);
    if (!p) {
      p = new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), this.t.connectMs);
        this.o.connect!(to).then(
          () => (clearTimeout(t), resolve(true)),
          () => (clearTimeout(t), resolve(false)),
        );
      }).then((ok) => {
        this.connecting.delete(to);
        if (ok) this.connectFailedAt.delete(to);
        else this.connectFailedAt.set(to, Date.now());
        return ok;
      });
      this.connecting.set(to, p);
    }
    return p;
  }

  private broadcast(k: GroupCallKind, extra: Partial<GroupCallFrame>): void {
    const c = this.cur;
    if (!c) return;
    for (const p of this.parts.values()) if (LIVE.includes(p.state)) void this.post(p.id, this.frame(k, c, p.id, extra), false);
  }

  private rosterNow(except = ''): RosterEntry[] {
    const r: RosterEntry[] = [{ id: this.myId, sid: this.sid }];
    for (const p of this.parts.values()) if (p.id !== except && LIVE.includes(p.state) && p.sid) r.push({ id: p.id, sid: p.sid });
    return r.slice(0, 16);
  }

  private ringingNow(except = ''): string[] {
    return [...this.parts.values()].filter((p) => p.id !== except && (p.state === 'reaching' || p.state === 'ringing')).map((p) => p.id).slice(0, 16);
  }

  // ---- receiving --------------------------------------------------------------------------------------

  /** Every gc-* frame from the locked chat channel of `fromId`. Other kinds are ignored. */
  onFrame(fromId: string, frame: unknown): void {
    const f = frame as GroupCallFrame;
    if (!shapeOk(f)) return;
    this.run(() => this.handle(fromId, f)).catch((e) => console.warn('P2P Talk: group call frame', e));
  }

  /** A group message (GroupManager 'message' event) whose body carries an invite: `{ gcall: frame }`. */
  onGroupMessage(m: { gid: string; from: string; body: unknown }): boolean {
    const f = (m.body as { gcall?: GroupCallFrame } | null)?.gcall;
    if (!f || typeof f !== 'object' || f.gid !== m.gid || (f.k !== 'gc-invite' && f.k !== 'gc-end')) return false;
    this.onFrame(m.from, f);
    return true;
  }

  /**
   * A locked 1:1 channel with this person just came up (call it from the Peer 'ready' handler). While
   * I am in a call of one of their groups: someone who was offline now rings; someone in the call gets
   * the invite again only as a hint (if their app restarted, it rings so they can rejoin).
   */
  peerReady(id: string): void {
    void this.run(async () => {
      const c = this.cur;
      if (!c || id === this.myId || !this.member(c.gid, id)) return;
      const p = this.parts.get(id);
      if (p && LIVE.includes(p.state)) {
        void this.post(id, this.frame('gc-invite', c, id, { video: c.video, in: this.rosterNow() }), false);
        return;
      }
      if (p && !(p.state === 'failed' && p.reason === 'offline')) return;
      this.inviteOne(c, id);
    });
  }

  private async handle(fromId: string, f: GroupCallFrame): Promise<void> {
    if (f.from !== fromId || f.from === this.myId) return;
    if (f.to !== this.myId && !(f.to === '' && (f.k === 'gc-invite' || f.k === 'gc-end'))) return;
    const m = this.member(f.gid, f.from);
    if (!m) return; // not in the current signed member list (or not a group I am in)
    let key: Uint8Array;
    try {
      key = fromB64url(m.identityKey);
    } catch {
      return;
    }
    if (!verify(key, frameBytes(f), fromB64url(f.sig))) return;
    switch (f.k) {
      case 'gc-invite':
        return this.onInvite(f, m);
      case 'gc-end':
        return this.onEnd(f);
      case 'gc-join':
        return this.onJoin(f, m);
      case 'gc-leave':
        return this.onLeave(f);
    }
    const c = this.cur;
    if (!c || c.cid !== f.cid) return;
    const p = this.parts.get(f.from);
    switch (f.k) {
      case 'gc-ring':
        if (p && (p.state === 'reaching' || (p.state === 'failed' && p.reason === 'offline'))) {
          this.setPart(p, 'ringing');
          this.arm(p, this.t.ringMs, () => p.state === 'ringing' && this.failPart(p, 'no-answer'));
        }
        return;
      case 'gc-decline':
      case 'gc-busy':
        if (p && !LIVE.includes(p.state)) this.failPart(p, f.k === 'gc-decline' ? 'declined' : 'busy');
        return;
      case 'gc-full':
        if (![...this.parts.values()].some((x) => x.state === 'connected')) this.leaveNow('full');
        else if (p) this.failPart(p, 'full');
        return;
      case 'gc-roster':
        this.learn(c, f.in ?? [], f.ringing ?? []);
        return;
      case 'gc-sdp':
        if (p) await this.onSdp(p, f);
        return;
      case 'gc-ice':
        if (p) await this.onIce(p, f);
        return;
      case 'gc-media':
        if (p) {
          p.mic = f.mic !== false;
          p.camera = !!f.cam;
          this.emitPart(p);
        }
        return;
      case 'gc-screen':
        if (p) this.onScreen(p, f);
        return;
    }
  }

  // ---- ringing ----------------------------------------------------------------------------------------

  private onInvite(f: GroupCallFrame, m: GroupMemberLike): void {
    if (this.cur?.cid === f.cid) {
      this.learn(this.cur, f.in ?? [], []); // a re-invite while I am in: only a hint of who is in
      return;
    }
    let c = this.calls.get(f.cid);
    if (c?.over || (c?.state === 'ended' && c.reason !== 'left')) return;
    // A copy carried by the group may be old: only a fresh one rings.
    if (f.to === '' && Math.abs((this.o.now ?? Date.now)() - f.ts) > this.t.ringMs + 60_000) return;
    if (this.cur || this.o.busy?.()) {
      void this.post(f.from, this.frame('gc-busy', { cid: f.cid, gid: f.gid } as Call, f.from), false);
      return;
    }
    const fresh = !c;
    if (!c) {
      c = { cid: f.cid, gid: f.gid, video: !!f.video, by: m.p2pId, state: 'incoming', known: new Map(), inviters: new Set(), at: Date.now() };
      this.calls.set(f.cid, c);
      this.prune();
    }
    c.inviters.add(f.from);
    for (const e of f.in ?? []) if (e.id !== this.myId && this.member(f.gid, e.id)) c.known.set(e.id, e.sid);
    if (c.state === 'declined') {
      void this.post(f.from, this.frame('gc-decline', c, f.from), false);
      return;
    }
    void this.post(f.from, this.frame('gc-ring', c, f.from), f.to === ''); // carried by the group: connect to answer
    // A call I missed, or left while it went on, rings again when someone in it invites me again
    // (I just answered them "ringing", so my screen must ring too, not stay silent).
    const again = !fresh && (c.state === 'missed' || (c.state === 'ended' && c.reason === 'left'));
    if (again) {
      clearTimeout(c.timer);
      c.state = 'incoming';
      c.reason = undefined;
    }
    if (fresh || again) {
      c.timer = setTimeout(() => void this.run(async () => c.state === 'incoming' && this.setCallState(c, 'missed')), this.t.ringMs + 5000);
      this.emit('invite', this.info(c));
      this.emitCall(c);
    }
  }

  private onEnd(f: GroupCallFrame): void {
    const c = this.calls.get(f.cid);
    if (!c || c === this.cur || c.over) return;
    c.over = true;
    this.setCallState(c, c.state === 'incoming' ? 'missed' : c.state, 'everyone-left');
  }

  private setCallState(c: Call, state: GroupCallState, reason?: GroupCallEndReason): void {
    clearTimeout(c.timer);
    c.state = state;
    c.reason = reason;
    this.emitCall(c);
  }

  private prune(): void {
    if (this.calls.size <= 40) return;
    for (const [cid, c] of this.calls) if (c !== this.cur && Date.now() - c.at > 3 * 3600_000) this.calls.delete(cid);
  }

  private inviteOne(c: Call, id: string): void {
    const m = this.member(c.gid, id);
    if (!m) return;
    const p = this.part(m);
    this.setPart(p, 'reaching');
    const f = this.frame('gc-invite', c, id, { video: c.video, in: this.rosterNow() });
    void this.post(id, f).then((ok) =>
      this.run(async () => {
        if (this.cur !== c || this.parts.get(id) !== p || p.state !== 'reaching') return;
        if (ok) {
          this.arm(p, this.t.reachMs, () => p.state === 'reaching' && this.failPart(p, 'offline'));
          return;
        }
        // Not reachable now: once per call, the invite goes into the group (members carry it).
        if (this.o.fanout && !c.fannedOut) {
          c.fannedOut = true;
          void this.o.fanout(c.gid, this.frame('gc-invite', c, '', { video: c.video, in: this.rosterNow() })).catch(() => undefined);
        }
        this.failPart(p, 'offline');
      }),
    );
  }

  // ---- actions ----------------------------------------------------------------------------------------

  /** Start a call in a group I have joined: everyone else in the member list rings. Returns the call ID. */
  async start(gid: string, opts: { video?: boolean } = {}): Promise<string> {
    const video = !!opts.video;
    if (this.cur) throw new Error('You are already in a call.');
    if (!this.roster(gid)) throw new Error('You are not in this group.');
    const media = await this.openMedia(video);
    return this.run(async () => {
      if (this.cur || !this.roster(gid)) {
        media.getTracks().forEach((t) => t.stop());
        throw new Error(this.cur ? 'You are already in a call.' : 'You are not in this group.');
      }
      const c: Call = { cid: randomId(), gid, video, by: this.myId, state: 'joined', known: new Map(), inviters: new Set(), at: Date.now() };
      this.calls.set(c.cid, c);
      this.enter(c, media, video);
      for (const m of this.roster(gid)!) if (m.p2pId !== this.myId) this.inviteOne(c, m.p2pId);
      this.emitCall(c);
      this.checkEnd(); // a group with nobody else
      return c.cid;
    });
  }

  /** Join (or rejoin) a call: incoming, missed, declined, or one I left while it still runs. */
  async join(callId: string): Promise<void> {
    const c0 = this.calls.get(callId);
    if (this.cur) throw new Error(this.cur === c0 ? 'Already in this call.' : 'You are already in a call.');
    if (!c0 || !this.canJoin(c0)) throw new Error('This call has ended.');
    const media = await this.openMedia(c0.video);
    await this.run(async () => {
      const c = this.calls.get(callId);
      const left = c?.state === 'ended' && c.reason === 'left';
      if (!c || this.cur || !this.canJoin(c) || !this.roster(c.gid)) {
        media.getTracks().forEach((t) => t.stop());
        throw new Error(this.cur ? 'You are already in a call.' : 'This call has ended.');
      }
      clearTimeout(c.timer);
      if (left) {
        c.known = new Map((c.lastRoster ?? []).map((e) => [e.id, e.sid]));
        c.reason = undefined;
      }
      this.enter(c, media, c.video);
      this.emitCall(c);
      this.learn(c, [...c.known].map(([id, sid]) => ({ id, sid })), left ? (c.lastRinging ?? []) : []);
      this.checkEnd();
    });
  }

  /** Decline an incoming call (they see "Declined"). Joining later is still possible while it runs. */
  async decline(callId: string): Promise<void> {
    await this.run(async () => {
      const c = this.calls.get(callId);
      if (!c || (c.state !== 'incoming' && c.state !== 'missed')) return;
      for (const id of c.inviters) void this.post(id, this.frame('gc-decline', c, id), false);
      this.setCallState(c, 'declined');
    });
  }

  /** Hang up. */
  async leave(): Promise<void> {
    await this.run(async () => this.leaveNow('left'));
  }

  private leaveNow(reason: GroupCallEndReason): void {
    const c = this.cur;
    if (!c) return;
    const stillIn = this.rosterNow().filter((e) => e.id !== this.myId);
    const ringing = this.ringingNow();
    for (const p of this.parts.values()) {
      if (LIVE.includes(p.state)) {
        void this.post(p.id, this.frame('gc-leave', c, p.id, { sid: this.sid, in: stillIn.filter((e) => e.id !== p.id), ringing }), false);
      }
    }
    if (!stillIn.length) this.tellOver(c);
    c.lastRoster = stillIn;
    c.lastRinging = ringing;
    this.teardown(c, reason);
  }

  private enter(c: Call, media: MediaStream, video: boolean): void {
    this.cur = c;
    c.state = 'joined';
    c.reason = undefined;
    this.sid = randomId();
    this.parts.clear();
    this.local = media;
    this.micTrack = media.getAudioTracks()[0] ?? null;
    this.camTrack = media.getVideoTracks()[0] ?? null;
    this.micOn = true;
    this.camOn = video && !!this.camTrack;
    this.extraAudio = null;
    this.screenTrack = null;
    this.sharer = null;
    this.speakerId = null;
    this.emit('localStream', media);
    if (this.t.pollMs > 0) this.poll = setInterval(() => void this.pollStats(), this.t.pollMs);
  }

  private teardown(c: Call, reason: GroupCallEndReason): void {
    clearInterval(this.poll);
    this.poll = undefined;
    for (const p of this.parts.values()) {
      clearTimeout(p.timer);
      this.closePair(p);
    }
    this.parts.clear();
    this.screenTrack?.stop();
    this.screenTrack = null;
    this.local?.getTracks().forEach((t) => t.stop());
    this.camTrack?.stop();
    this.local = null;
    this.micTrack = this.camTrack = this.extraAudio = null;
    const hadSharer = !!this.sharer;
    this.sharer = null;
    this.cur = null;
    this.sid = '';
    if (hadSharer) this.emit('screen', null);
    this.emit('localStream', null);
    this.setCallState(c, 'ended', reason);
  }

  /** The call ends for me when nobody else is in it, being reached or ringing. */
  private checkEnd(): void {
    const c = this.cur;
    if (!c) return;
    if ([...this.parts.values()].some((p) => PENDING.includes(p.state))) return;
    c.lastRoster = [];
    c.lastRinging = [];
    this.tellOver(c);
    this.teardown(c, 'everyone-left');
  }

  /** The last one out: members who were rung and are not in it see the call as over (no more "Join"). */
  private tellOver(c: Call): void {
    for (const p of this.parts.values()) {
      if (p.state === 'reaching' || p.state === 'ringing' || (p.state === 'failed' && (p.reason === 'no-answer' || p.reason === 'declined'))) {
        void this.post(p.id, this.frame('gc-end', c, p.id), false);
      }
    }
  }

  // ---- participants -----------------------------------------------------------------------------------

  private part(m: GroupMemberLike): Part {
    let p = this.parts.get(m.p2pId);
    if (!p) {
      p = {
        id: m.p2pId,
        name: m.name,
        state: 'reaching',
        sid: '',
        pc: null,
        fp: '',
        stream: null,
        ice: [],
        makingOffer: false,
        ignoreOffer: false,
        offeredFor: '',
        restarted: false,
        level: 0,
        lastLoud: 0,
        speaking: false,
        mic: true,
        camera: !!this.cur?.video,
        screen: false,
        step: '',
      };
      this.parts.set(p.id, p);
    }
    return p;
  }

  private setPart(p: Part, state: ParticipantState, reason?: ParticipantReason): void {
    if (state !== 'connecting' && state !== 'reaching' && state !== 'ringing') clearTimeout(p.timer);
    p.state = state;
    p.reason = reason;
    if (state === 'failed' || state === 'left') {
      p.speaking = false;
      if (p.screen) {
        p.screen = false;
        if (this.sharer?.id === p.id) {
          this.sharer = null;
          this.emit('screen', null);
        }
      }
    }
    this.emitPart(p);
  }

  private failPart(p: Part, reason: ParticipantReason): void {
    this.closePair(p);
    this.setPart(p, 'failed', reason);
    this.checkEnd();
  }

  private arm(p: Part, ms: number, fn: () => void): void {
    clearTimeout(p.timer);
    p.timer = setTimeout(() => void this.run(async () => this.parts.get(p.id) === p && fn()), ms);
  }

  /** Someone (or a list of them) is in the call: connect to the ones I am not connected to yet. */
  private learn(c: Call, inList: RosterEntry[], ringing: string[]): void {
    if (this.cur !== c) return;
    for (const e of inList) {
      if (e.id === this.myId || !e.sid) continue;
      const m = this.member(c.gid, e.id);
      if (!m) continue; // only members of the current signed list
      const p = this.parts.get(e.id);
      if (p && LIVE.includes(p.state) && p.sid === e.sid) continue;
      if (p && p.state === 'left' && p.sid === e.sid) continue; // that session already left
      this.contact(c, m, e.sid);
    }
    for (const id of ringing) {
      if (id === this.myId || this.parts.has(id)) continue;
      const m = this.member(c.gid, id);
      if (!m) continue;
      const p = this.part(m);
      this.setPart(p, 'ringing');
      this.arm(p, this.t.ringMs, () => p.state === 'ringing' && this.failPart(p, 'no-answer'));
    }
  }

  /** Tell one person in the call that I am in (gc-join); the lower ID of the two makes the offer. */
  private contact(c: Call, m: GroupMemberLike, sid: string): void {
    const p = this.part(m);
    if (p.sid && p.sid !== sid) this.closePair(p);
    p.sid = sid;
    this.setPart(p, 'connecting');
    this.arm(p, this.t.mediaMs, () => p.state === 'connecting' && this.mediaFailed(p));
    void this.post(p.id, this.frame('gc-join', c, p.id, { sid: this.sid, video: c.video }));
    this.sendMyState(p);
    if (this.myId < p.id) void this.makeOffer(p);
  }

  private onJoin(f: GroupCallFrame, m: GroupMemberLike): void {
    const c = this.cur;
    if (!c || c.cid !== f.cid) {
      // Not (or no longer) in it: tell them who was still in when I left, so they find the others.
      const old = this.calls.get(f.cid);
      if (old && old.state === 'ended' && old.gid === f.gid) {
        void this.post(f.from, this.frame('gc-leave', old, f.from, { sid: '', in: (old.lastRoster ?? []).filter((e) => e.id !== f.from), ringing: [] }), false);
      }
      return;
    }
    if (!isStr(f.sid, 40) || !f.sid) return;
    let p = this.parts.get(f.from);
    const same = !!p && p.sid === f.sid && LIVE.includes(p.state);
    if (!same) {
      const live = [...this.parts.values()].filter((x) => LIVE.includes(x.state) && x.id !== f.from).length + 1;
      if (live >= maxPeople(c.video)) {
        void this.post(f.from, this.frame('gc-full', c, f.from), false);
        p = this.part(m);
        this.closePair(p);
        this.setPart(p, 'failed', 'full');
        return;
      }
      p = this.part(m);
      if (p.sid && p.sid !== f.sid) this.closePair(p); // they rejoined (new session): a new connection
      p.sid = f.sid;
      p.mic = true;
      p.camera = !!f.video;
      this.setPart(p, 'connecting');
      this.arm(p, this.t.mediaMs, () => p!.state === 'connecting' && this.mediaFailed(p!));
      this.sendMyState(p);
      if (this.myId < p.id) void this.makeOffer(p);
    }
    void this.post(f.from, this.frame('gc-roster', c, f.from, { in: this.rosterNow(f.from), ringing: this.ringingNow(f.from) }), false);
    this.applyBitratesAll();
  }

  private onLeave(f: GroupCallFrame): void {
    const c = this.calls.get(f.cid);
    if (!c) return;
    if (c !== this.cur) {
      if (c.known.has(f.from)) c.known.delete(f.from);
      for (const e of f.in ?? []) if (e.id !== this.myId && this.member(c.gid, e.id)) c.known.set(e.id, e.sid);
      return;
    }
    const p = this.parts.get(f.from);
    if (p && (!f.sid || !p.sid || f.sid === p.sid)) {
      this.closePair(p);
      this.setPart(p, 'left');
    }
    this.learn(c, f.in ?? [], f.ringing ?? []);
    this.applyBitratesAll();
    this.checkEnd();
  }

  private sendMyState(p: Part): void {
    const c = this.cur!;
    void this.post(p.id, this.frame('gc-media', c, p.id, { mic: this.micOn, cam: this.camOn }), false);
    if (this.sharer?.id === this.myId) void this.post(p.id, this.frame('gc-screen', c, p.id, { on: true, at: this.sharer.ts }), false);
  }

  // ---- the pair connection ----------------------------------------------------------------------------

  private newPc(p: Part, offerer: boolean): RTCPeerConnection {
    const make = this.o.createPeerConnection ?? ((cfg: RTCConfiguration) => new RTCPeerConnection(cfg));
    const pc = make({ iceServers: this.o.iceServers ?? DEFAULT_ICE, bundlePolicy: 'max-bundle' });
    p.pc = pc;
    p.fp = '';
    p.ice = [];
    p.step = '';
    p.restarted = false; // one ICE restart per connection (not per person for the whole call)
    p.stream = this.o.newStream ? this.o.newStream() : new MediaStream();
    if (offerer) {
      // One audio and one video line, always: camera on/off and screen share are then only replaceTrack.
      const streams = this.local ? [this.local] : [];
      pc.addTransceiver(this.audioOut() ?? 'audio', { direction: 'sendrecv', streams });
      pc.addTransceiver(this.videoOut() ?? 'video', { direction: 'sendrecv', streams });
    }
    pc.addEventListener('icecandidate', (e: RTCPeerConnectionIceEvent) => {
      const c = this.cur;
      if (p.pc !== pc || !c || !e.candidate) return;
      void this.post(p.id, this.frame('gc-ice', c, p.id, { sid: this.sid, rsid: p.sid, c: e.candidate.toJSON() }), false);
    });
    pc.addEventListener('track', (e: RTCTrackEvent) => {
      if (p.pc !== pc || !p.stream) return;
      const t = e.track;
      if (!p.stream.getTracks().includes(t)) p.stream.addTrack(t);
      const changed = () => {
        if (p.pc !== pc) return;
        this.checkConnected(p);
        this.emitPart(p);
      };
      t.addEventListener('unmute', changed);
      t.addEventListener('mute', changed);
      t.addEventListener('ended', () => {
        p.stream?.removeTrack(t);
        changed();
      });
      changed();
    });
    pc.addEventListener('connectionstatechange', () => {
      if (p.pc !== pc) return;
      const s = pc.connectionState;
      if (s === 'connected') this.checkConnected(p);
      else if (s === 'failed') void this.run(async () => p.pc === pc && this.pairFailed(p));
    });
    return pc;
  }

  private checkConnected(p: Part): void {
    const pc = p.pc;
    if (!pc || p.state !== 'connecting' || pc.connectionState !== 'connected') return;
    if (!p.stream?.getTracks().some((t) => !t.muted)) return;
    this.setPart(p, 'connected');
    this.applyBitratesAll();
  }

  private pairFailed(p: Part): void {
    // One ICE restart (by the side that offers), then give up on this pair.
    if (!p.restarted && LIVE.includes(p.state)) {
      p.restarted = true;
      if (p.state === 'connected') this.setPart(p, 'connecting');
      this.arm(p, this.t.mediaMs, () => p.state === 'connecting' && this.mediaFailed(p));
      if (this.myId < p.id) void this.makeOffer(p, true);
      return;
    }
    this.mediaFailed(p);
  }

  private mediaFailed(p: Part): void {
    this.closePair(p);
    this.setPart(p, 'failed', 'media');
    this.checkEnd();
  }

  private closePair(p: Part): void {
    const pc = p.pc;
    p.pc = null;
    p.fp = '';
    p.ice = [];
    p.makingOffer = false;
    p.offeredFor = '';
    p.speaking = false;
    if (pc) {
      try {
        pc.close();
      } catch {
        /* closed */
      }
    }
    p.stream?.getTracks().forEach((t) => p.stream?.removeTrack(t));
    p.stream = null;
  }

  private async makeOffer(p: Part, iceRestart = false): Promise<void> {
    const c = this.cur;
    if (!c || p.makingOffer) return;
    if (!iceRestart && p.pc && p.offeredFor === p.sid) return;
    p.makingOffer = true;
    try {
      const pc = p.pc ?? this.newPc(p, true);
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (p.pc !== pc || pc.signalingState !== 'stable' || this.cur !== c) return;
      await pc.setLocalDescription(offer);
      const d = pc.localDescription!;
      p.offeredFor = p.sid;
      void this.post(p.id, this.frame('gc-sdp', c, p.id, { sid: this.sid, rsid: p.sid, d: { type: 'offer', sdp: d.sdp }, fp: sdpFingerprint(d.sdp) }), false);
    } catch (e) {
      console.warn('P2P Talk: group call offer', e);
    } finally {
      p.makingOffer = false;
    }
  }

  /** Either side: make a fresh offer with new network addresses (also what a "Reconnect" button does). */
  restartPair(id: string): Promise<void> {
    return this.run(async () => {
      const p = this.parts.get(id);
      if (p?.pc && LIVE.includes(p.state)) await this.makeOffer(p, true);
    });
  }

  private async onSdp(p: Part, f: GroupCallFrame): Promise<void> {
    const c = this.cur!;
    const d = f.d!;
    if (f.rsid !== this.sid || !LIVE.includes(p.state)) return; // meant for an older session of mine
    if (f.sid !== p.sid) {
      if (d.type !== 'offer' || !f.sid) return;
      this.closePair(p); // their new session
      p.sid = f.sid;
    }
    // The DTLS fingerprint is the one they signed, and it stays the same for this connection.
    let fp: string;
    try {
      fp = sdpFingerprint(d.sdp);
    } catch {
      return;
    }
    if (fp !== f.fp || (p.fp && p.fp !== fp)) {
      this.mediaFailed(p);
      return;
    }
    const polite = this.myId > p.id;
    let pc = p.pc;
    if (d.type === 'answer') {
      if (!pc || pc.signalingState !== 'have-local-offer') return;
    } else {
      const collision = !!pc && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !polite && collision;
      if (p.ignoreOffer) return;
      if (pc && collision) {
        if (!pc.currentRemoteDescription) {
          // Both made a first offer: drop mine and answer theirs on a new connection.
          this.closePair(p);
          p.sid = f.sid!;
          pc = null;
        } else {
          await pc.setLocalDescription({ type: 'rollback' });
        }
      }
      pc ??= this.newPc(p, false);
    }
    await pc.setRemoteDescription({ type: d.type, sdp: d.sdp });
    if (p.pc !== pc) return;
    p.fp = fp;
    for (const cand of p.ice.splice(0)) await pc.addIceCandidate(cand).catch(() => undefined);
    if (d.type === 'offer') {
      await this.attachLocal(pc);
      await pc.setLocalDescription(await pc.createAnswer());
      const a = pc.localDescription!;
      void this.post(p.id, this.frame('gc-sdp', c, p.id, { sid: this.sid, rsid: p.sid, d: { type: 'answer', sdp: a.sdp }, fp: sdpFingerprint(a.sdp) }), false);
    }
    p.step = '';
    this.applyBitrates(p);
  }

  private async onIce(p: Part, f: GroupCallFrame): Promise<void> {
    if (f.rsid !== this.sid || f.sid !== p.sid || !f.c) return;
    const pc = p.pc;
    if (!pc || !pc.remoteDescription) {
      if (p.ice.length < 50) p.ice.push(f.c);
      return;
    }
    try {
      await pc.addIceCandidate(f.c);
    } catch (e) {
      if (!p.ignoreOffer) console.warn('P2P Talk: group call ice', e);
    }
  }

  /** Answerer: my tracks on the transceivers their offer made, and send on them. */
  private async attachLocal(pc: RTCPeerConnection): Promise<void> {
    for (const t of pc.getTransceivers()) {
      if (t.mid === null || t.direction === 'stopped' || t.currentDirection === 'stopped') continue;
      t.direction = 'sendrecv';
      const track = t.receiver.track.kind === 'audio' ? this.audioOut() : this.videoOut();
      if (t.sender.track !== track) await t.sender.replaceTrack(track).catch(() => undefined);
      if (this.local) (t.sender as RTCRtpSender & { setStreams?: (...s: MediaStream[]) => void }).setStreams?.(this.local);
    }
  }

  private sender(pc: RTCPeerConnection, kind: 'audio' | 'video'): RTCRtpSender | undefined {
    return pc.getTransceivers().find((t) => t.mid !== null && t.receiver.track.kind === kind && t.direction !== 'stopped' && t.currentDirection !== 'stopped')?.sender
      ?? pc.getTransceivers().find((t) => t.receiver.track.kind === kind && t.direction !== 'stopped')?.sender;
  }

  private audioOut(): MediaStreamTrack | null {
    return this.extraAudio ?? this.micTrack;
  }

  private videoOut(): MediaStreamTrack | null {
    return this.screenTrack ?? this.camTrack;
  }

  private async replaceAll(kind: 'audio' | 'video', track: MediaStreamTrack | null): Promise<void> {
    await Promise.all(
      [...this.parts.values()].map(async (p) => {
        const s = p.pc && this.sender(p.pc, kind);
        if (s && s.track !== track) await s.replaceTrack(track).catch(() => undefined);
      }),
    );
  }

  // ---- bitrates ---------------------------------------------------------------------------------------

  /** People in the call now, me included. */
  get size(): number {
    return 1 + [...this.parts.values()].filter((p) => LIVE.includes(p.state)).length;
  }

  private applyBitratesAll(): void {
    for (const p of this.parts.values()) this.applyBitrates(p);
  }

  private applyBitrates(p: Part): void {
    const pc = p.pc;
    if (!pc || !pc.remoteDescription || pc.signalingState !== 'stable') return;
    const step = videoStep(this.size);
    const screen = !!this.screenTrack;
    const key = `${step.maxBitrate}|${screen}`;
    if (p.step === key) return;
    p.step = key;
    const set = (s: RTCRtpSender | undefined, enc: RTCRtpEncodingParameters) => {
      if (!s) return;
      try {
        const params = s.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0] = { ...params.encodings[0], ...enc };
        void s.setParameters(params).catch(() => (p.step = ''));
      } catch {
        p.step = '';
      }
    };
    set(this.sender(pc, 'audio'), { maxBitrate: AUDIO_MAX_BITRATE });
    set(this.sender(pc, 'video'), { maxBitrate: step.maxBitrate, scaleResolutionDownBy: screen ? 1 : step.scale });
  }

  // ---- my media ---------------------------------------------------------------------------------------

  private async openMedia(video: boolean): Promise<MediaStream> {
    const gum = this.o.getUserMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
    // The camera and microphone picked last time (call › Devices), else the front camera.
    return openChosen(gum, SOUND, video ? CAMERA : false);
  }

  /** Microphone on / off (they see the muted icon on my tile). */
  setMic(on: boolean): void {
    this.micOn = on;
    if (this.micTrack) this.micTrack.enabled = on;
    this.broadcast('gc-media', { mic: this.micOn, cam: this.camOn });
  }

  /** Camera on / off. In a voice call, turning it on opens the camera and sends it (no renegotiation). */
  async setCamera(on: boolean): Promise<void> {
    if (!this.cur) return;
    if (on && !this.camTrack) {
      const gum = this.o.getUserMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
      const s = await openChosen(gum, false, CAMERA);
      const t = s.getVideoTracks()[0];
      if (!t) return;
      if (!this.cur) {
        t.stop();
        return;
      }
      this.camTrack = t;
      this.local?.addTrack(t);
      if (!this.screenTrack) await this.replaceAll('video', t);
      this.emit('localStream', this.local);
    }
    if (this.camTrack) this.camTrack.enabled = on;
    this.camOn = on && !!this.camTrack;
    this.broadcast('gc-media', { mic: this.micOn, cam: this.camOn });
  }

  /**
   * Another camera during the call (Flip, or call › Devices): replaceTrack on every pair (no
   * renegotiation). While my screen is shared, the new camera waits and goes out when sharing stops.
   */
  async switchCamera(which: { id: string } | { facing: 'user' | 'environment' }): Promise<MediaStreamTrack | null> {
    if (!this.cur || !this.camTrack) return null;
    const gum = this.o.getUserMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
    const s = await gum({ video: 'id' in which ? exactly(which.id, CAMERA) : { ...CAMERA, facingMode: { exact: which.facing } } });
    const t = s.getVideoTracks()[0];
    if (!t) return null;
    const old = this.camTrack;
    if (!this.cur || !old) {
      t.stop();
      return null;
    }
    t.enabled = old.enabled;
    this.camTrack = t;
    this.local?.addTrack(t);
    if (!this.screenTrack) await this.replaceAll('video', t);
    this.local?.removeTrack(old);
    old.stop();
    this.emit('localStream', this.local);
    return t;
  }

  /** Another microphone during the call (call › Devices): replaceTrack on every pair. */
  async switchMic(id: string): Promise<MediaStreamTrack | null> {
    if (!this.cur) return null;
    if (this.extraAudio) throw new Error('Stop sharing your screen first, then change the microphone.');
    const gum = this.o.getUserMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
    const s = await gum({ audio: exactly(id, SOUND) });
    const t = s.getAudioTracks()[0];
    if (!t) return null;
    if (!this.cur) {
      t.stop();
      return null;
    }
    const old = this.micTrack;
    t.enabled = this.micOn;
    this.micTrack = t;
    this.local?.addTrack(t);
    await this.replaceAll('audio', this.audioOut());
    if (old) {
      this.local?.removeTrack(old);
      old.stop();
    }
    this.emit('localStream', this.local);
    return t;
  }

  /** The tracks I send now (the Devices sheet ticks the devices they use). */
  get myTracks(): { mic: MediaStreamTrack | null; cam: MediaStreamTrack | null } {
    return { mic: this.micTrack, cam: this.camTrack };
  }

  /**
   * Send another audio track instead of the plain microphone (the app's mix of microphone + device
   * sound while sharing the screen). null: back to the microphone.
   */
  async setAudioTrack(track: MediaStreamTrack | null): Promise<void> {
    this.extraAudio = track;
    await this.replaceAll('audio', this.audioOut());
  }

  /**
   * Share my screen with everyone (it goes out instead of my camera). One person at a time: throws
   * while someone else shares. Returns the capture stream (its audio track, if any, is the device
   * sound for the app's mix → setAudioTrack).
   */
  async startScreen(): Promise<MediaStream | null> {
    const c = this.cur;
    if (!c) throw new Error('Not in a call.');
    if (this.screenTrack) return null;
    if (this.sharer && this.sharer.id !== this.myId) {
      const who = this.parts.get(this.sharer.id)?.name || 'Someone';
      throw new Error(`${who} is sharing their screen. One person at a time.`);
    }
    const gdm = this.o.getDisplayMedia ?? (() => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true } as DisplayMediaStreamOptions));
    const s = await gdm();
    const t = s.getVideoTracks()[0];
    if (!t) return null;
    if (this.cur !== c || (this.sharer && this.sharer.id !== this.myId)) {
      s.getTracks().forEach((x) => x.stop());
      throw new Error('Someone else started sharing first.');
    }
    try {
      (t as MediaStreamTrack & { contentHint: string }).contentHint = 'detail';
    } catch {
      /* not supported */
    }
    this.screenTrack = t;
    t.addEventListener('ended', () => void this.stopScreen());
    this.sharer = { id: this.myId, ts: (this.o.now ?? Date.now)() };
    await this.replaceAll('video', t);
    for (const p of this.parts.values()) p.step = '';
    this.applyBitratesAll();
    this.broadcast('gc-screen', { on: true, at: this.sharer.ts });
    this.emit('screen', this.myId);
    return s;
  }

  async stopScreen(): Promise<void> {
    const t = this.screenTrack;
    if (!t) return;
    this.screenTrack = null;
    t.stop();
    if (this.sharer?.id === this.myId) this.sharer = null;
    if (!this.cur) return;
    await this.replaceAll('video', this.camTrack);
    for (const p of this.parts.values()) p.step = '';
    this.applyBitratesAll();
    this.broadcast('gc-screen', { on: false });
    this.emit('screen', this.sharer?.id ?? null);
  }

  private onScreen(p: Part, f: GroupCallFrame): void {
    if (f.on) {
      const at = typeof f.at === 'number' && Number.isFinite(f.at) ? f.at : f.ts;
      const s = this.sharer;
      if (s && s.id !== p.id) {
        // Two started at once: everyone keeps the earlier one (same time: the lower ID).
        const theirsWins = at < s.ts || (at === s.ts && p.id < s.id);
        if (!theirsWins) return;
        if (s.id === this.myId) void this.stopScreen();
        else {
          const other = this.parts.get(s.id);
          if (other) {
            other.screen = false;
            this.emitPart(other);
          }
        }
      }
      this.sharer = { id: p.id, ts: at };
      p.screen = true;
      this.emitPart(p);
      this.emit('screen', p.id);
    } else if (p.screen) {
      p.screen = false;
      if (this.sharer?.id === p.id) this.sharer = null;
      this.emitPart(p);
      this.emit('screen', this.sharer?.id ?? null);
    }
  }

  // ---- levels, speaker, path, stats -------------------------------------------------------------------

  private async pollStats(): Promise<void> {
    if (!this.cur) return;
    const now = Date.now();
    let loudest: { id: string; level: number } | null = null;
    await Promise.all(
      [...this.parts.values()].map(async (p) => {
        const pc = p.pc;
        if (!pc || p.state !== 'connected') return;
        let report: RTCStatsReport;
        try {
          report = await pc.getStats();
        } catch {
          return;
        }
        if (p.pc !== pc) return;
        let level = 0;
        report.forEach((r: { type?: string; kind?: string; audioLevel?: number }) => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio' && typeof r.audioLevel === 'number') level = Math.max(level, r.audioLevel);
        });
        p.level = level;
        if (level >= SPEAK_LEVEL) p.lastLoud = now;
        const speaking = p.mic && now - p.lastLoud < SPEAK_HOLD_MS;
        let changed = speaking !== p.speaking;
        p.speaking = speaking;
        try {
          const path = pathFromStats(report);
          if (path.kind !== p.path?.kind || path.networkType !== p.path?.networkType) {
            p.path = path;
            changed = true;
          }
        } catch {
          /* no path yet */
        }
        if (speaking && (!loudest || level > loudest.level)) loudest = { id: p.id, level };
        if (changed) this.emitPart(p);
      }),
    );
    if (!this.cur) return;
    const top = loudest as { id: string; level: number } | null;
    const current = this.speakerId ? this.parts.get(this.speakerId) : undefined;
    // Keep the big tile on whoever speaks until someone else speaks (no flicker in pauses).
    if (top && top.id !== this.speakerId && !(current?.speaking && current.level >= top.level * 0.8)) {
      this.speakerId = top.id;
      this.emit('speaker', top.id);
    }
  }

  /** Bytes in and out per person, for "Connection details" and tests. */
  async stats(): Promise<Record<string, PairStats>> {
    const out: Record<string, PairStats> = {};
    await Promise.all(
      [...this.parts.values()].map(async (p) => {
        if (!p.pc) return;
        const s: PairStats = { state: p.state, audioIn: 0, videoIn: 0, audioOut: 0, videoOut: 0, framesDecoded: 0, frameWidth: 0, frameHeight: 0, outFrameWidth: 0, audioLevel: 0, rttMs: 0 };
        try {
          (await p.pc.getStats()).forEach((r: Record<string, unknown> & { type?: string; kind?: string }) => {
            const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
            if (r.type === 'inbound-rtp') {
              if (r.kind === 'audio') {
                s.audioIn += n('bytesReceived');
                s.audioLevel = Math.max(s.audioLevel, n('audioLevel'));
              } else if (r.kind === 'video') {
                s.videoIn += n('bytesReceived');
                s.framesDecoded += n('framesDecoded');
                s.frameWidth = Math.max(s.frameWidth, n('frameWidth'));
                s.frameHeight = Math.max(s.frameHeight, n('frameHeight'));
              }
            } else if (r.type === 'outbound-rtp') {
              if (r.kind === 'audio') s.audioOut += n('bytesSent');
              else if (r.kind === 'video') {
                s.videoOut += n('bytesSent');
                s.outFrameWidth = Math.max(s.outFrameWidth, n('frameWidth'));
              }
            } else if (r.type === 'candidate-pair' && r.nominated && typeof r.currentRoundTripTime === 'number') {
              s.rttMs = Math.round((r.currentRoundTripTime as number) * 1000);
            }
          });
        } catch {
          return;
        }
        out[p.id] = s;
      }),
    );
    return out;
  }

  /** The encodings now set on my outgoing senders to this person (tests / details). */
  senderParams(id: string): { audio?: RTCRtpEncodingParameters; video?: RTCRtpEncodingParameters } {
    const pc = this.parts.get(id)?.pc;
    if (!pc) return {};
    return { audio: this.sender(pc, 'audio')?.getParameters().encodings?.[0], video: this.sender(pc, 'video')?.getParameters().encodings?.[0] };
  }

  /** Stop listening to the groups and end any call (app shutdown, sign out). */
  destroy(): void {
    if (this.cur) this.leaveNow('left');
    for (const c of this.calls.values()) clearTimeout(c.timer);
    this.unsub.splice(0).forEach((u) => u());
  }
}

export interface PairStats {
  state: ParticipantState;
  audioIn: number;
  videoIn: number;
  audioOut: number;
  videoOut: number;
  framesDecoded: number;
  frameWidth: number;
  frameHeight: number;
  outFrameWidth: number;
  audioLevel: number;
  rttMs: number;
}
