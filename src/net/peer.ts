// One direct connection to one person: WebRTC with manual (QR / text) signalling, a locked
// data channel, a heartbeat for online/offline, the connection path, and 1:1 calls that are
// renegotiated over the locked data channel (no second QR).

import { fromUtf8, toB64url, utf8 } from '../core/bytes';
import { deviceProof, verifyCert, verifyDeviceProof, type DeviceCert, type DeviceInfo } from '../core/device';
import { p2pId } from '../core/identity';
import { newEphemeral, SessionLock } from '../core/lock';
import { pathFromStats, type PathInfo } from '../core/path';
import { SerialQueue } from '../core/queue';
import { testFlag } from '../core/testmode';
import { exactly, openChosen } from '../core/mediaDevices';
import { beginAttempt, mask, note, summarize, type Attempt } from './diag';
import { rtcBinaryChannel, type Channel } from '../core/channel';
import { FILE_CHANNEL_PREFIX, FILE_FEATURE, FILE_KINDS } from './files';
import { GROUP_FEATURE, GROUP_KINDS } from './groups';
import { GROUP_CALL_FEATURE, GROUP_CALL_KINDS } from './groupCall';
import { PIC_FEATURE, PIC_KINDS } from './photos';
import { RCPT_FEATURE, RCPT_KINDS } from './receipts';
import { decodeCode, encodeCode, makeCode, sdpFingerprint, verifyCode, type VerifiedCode } from '../core/signal';

/** Public STUN only (to learn our own internet address). No TURN, no relay. */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const GATHER_LIMIT_MS = 6000;
const HEARTBEAT_MS = 5000;
const ONLINE_WINDOW_MS = 12000;
const REACH_TIMEOUT_MS = 8000;
const MEDIA_TIMEOUT_MS = 25000;
/** ICE "disconnected" this long: restart ICE (BUG-8). "failed" restarts at once. */
export const STALL_MS = 5000;
/** A restart that has not worked: try again this often (over the chat channel and the relays). */
export const RESTART_EVERY_MS = 5000;
/** Reconnecting this long without success: the connection (and the call) ends. */
export const RECONNECT_GIVE_UP_MS = 20_000;

/** Test-only: leave the network addresses out of my codes, so no direct path can be found. */
const BREAK_ICE = testFlag('breakIce') === '1';
/** How long a connection may take to open after the answer is in (tests can shorten it with ?connectWait=). */
export const CONNECT_WAIT_MS = Number(testFlag('connectWait')) > 0 ? Number(testFlag('connectWait')) : 20_000;

/** The direct connection did not open in time (or failed). */
export class ConnectFailed extends Error {
  constructor(readonly why: 'timeout' | 'failed' | 'closed') {
    super('Can’t connect directly.');
  }
}

const withoutCandidates = (sdp: string) => (BREAK_ICE ? sdp.replace(/^a=candidate:.*\r?\n/gm, '').replace(/^a=end-of-candidates\r?\n/gm, '') : sdp);
/** Data-channel protocol version, sent in the first hello (PROTOCOL §7.2). */
export const PROTOCOL_VERSION = 1;
/** What this build understands, sent in the first hello. Unknown frame kinds are always ignored. */
export const FEATURES = ['chat', 'call', 'media-failed', 'rec', 'device', 'devs', 'taken', 'screen', FILE_FEATURE, GROUP_FEATURE, GROUP_CALL_FEATURE, PIC_FEATURE, RCPT_FEATURE] as const;
/** Test-only: an ICE restart offer goes through the relays only, never the chat channel (?restartViaRelays=1). */
const RESTART_VIA_RELAYS_ONLY = testFlag('restartViaRelays') === '1';
/** Test-only: slow each file data frame down by this many ms (?fileDelay=20), to test pause and resume. */
const FILE_DELAY_MS = Number(testFlag('fileDelay')) || 0;

export interface Me {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  name: string;
  /** This device's own key and certificate (multi-device). */
  device?: { secretKey: Uint8Array; publicKey: Uint8Array; cert: DeviceCert };
}

export interface PeerInfo {
  id: string;
  publicKey: Uint8Array;
  name: string;
  /** Their device, when their hello carried a valid device certificate and proof. */
  device?: DeviceInfo & { cert: DeviceCert };
  /** From their hello (0 / [] for builds before version and features were sent). */
  version: number;
  features: string[];
}

export type CallState =
  | 'idle'
  | 'reaching' // caller: call offer sent, no reply yet
  | 'ringing' //  caller: their device shows the incoming call
  | 'incoming' // callee: Accept / Decline
  | 'connecting' // accepted, media being set up
  | 'connected'
  | 'reconnecting' // the network stalled mid-call: ICE restart; back to connected, or ended after ~20 s
  | 'ended'
  | 'missed' //   callee: caller gave up
  | 'failed';

/** media: the connection for sound/video failed; my-media / their-media: a camera or microphone couldn't open. */
export type CallFailure = 'offline' | 'no-answer' | 'declined' | 'busy' | 'media' | 'my-media' | 'their-media';

export interface CallInfo {
  state: CallState;
  video: boolean;
  outgoing: boolean;
  failure?: CallFailure;
  connectedAt?: number;
}

export interface PeerEvents {
  ready(peer: PeerInfo): void;
  message(m: { mid: string; text: string; ts: number }): void;
  presence(online: boolean, lastSeen: number): void;
  path(p: PathInfo): void;
  call(c: CallInfo): void;
  localStream(s: MediaStream | null): void;
  remoteStream(s: MediaStream | null): void;
  /** The other side started or stopped recording this call. */
  recording(on: boolean): void;
  /** Screen sharing changed: `mine` (I share) or theirs; `sound`: my device sound is going out with it. */
  screen(s: { mine: boolean; theirs: boolean; sound: boolean; soundCaptured: boolean }): void;
  /** Certificates of my other devices this contact has seen (still to be checked by the caller). */
  devices(list: { c: DeviceCert; s: number }[]): void;
  /** A file or group frame (files2 / groups1) for the engines, in arrival order. */
  frame(f: object): void;
  /** They opened a data channel for one file transfer. */
  fileChannel(ch: Channel): void;
  /** The network under this connection stalled ('reconnecting': ICE restart running) or is back ('up'). */
  link(state: 'up' | 'reconnecting'): void;
  closed(): void;
}

// ---- keeping a connection through a network change (BUG-8) ------------------------------------------

export interface LinkWatchHooks {
  /** Start (or repeat) an ICE restart. `attempt` counts from 1. */
  restart(attempt: number): void;
  /** Reconnecting began, or the link is up again. */
  change(state: 'up' | 'reconnecting'): void;
  /** Reconnecting did not work within RECONNECT_GIVE_UP_MS: end the connection. */
  giveUp(): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * The ICE state of a connection that was up, turned into what to do: "disconnected" for STALL_MS or
 * "failed" → ICE restart (repeated every RESTART_EVERY_MS); "connected" → up again; nothing working for
 * RECONNECT_GIVE_UP_MS after the restart began → give up. Pure logic (unit-tested with fake timers).
 */
export class LinkWatch {
  state: 'up' | 'stalled' | 'restarting' | 'down' = 'up';
  private timers: unknown[] = [];
  private attempt = 0;
  private readonly set: (fn: () => void, ms: number) => unknown;
  private readonly clear: (t: unknown) => void;

  constructor(private readonly h: LinkWatchHooks) {
    this.set = h.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clear = h.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  ice(s: RTCIceConnectionState): void {
    if (this.state === 'down') return;
    if (s === 'connected' || s === 'completed') {
      if (this.state === 'up') return;
      this.clearAll();
      this.state = 'up';
      this.h.change('up');
    } else if (s === 'closed') {
      this.stop();
    } else if (s === 'disconnected') {
      if (this.state !== 'up') return;
      this.state = 'stalled';
      this.h.change('reconnecting');
      this.timers.push(this.set(() => this.state === 'stalled' && this.begin(), STALL_MS));
    } else if (s === 'failed') {
      if (this.state === 'up') {
        this.state = 'stalled';
        this.h.change('reconnecting');
      }
      if (this.state === 'stalled') this.begin();
    }
    // 'new' / 'checking' (during a restart): no change.
  }

  stop(): void {
    this.clearAll();
    this.state = 'down';
  }

  private begin(): void {
    this.clearAll();
    this.state = 'restarting';
    this.attempt = 0;
    this.timers.push(
      this.set(() => {
        if (this.state !== 'restarting') return;
        this.stop();
        this.h.giveUp();
      }, RECONNECT_GIVE_UP_MS),
    );
    this.kick();
  }

  private kick(): void {
    if (this.state !== 'restarting') return;
    this.h.restart(++this.attempt);
    this.timers.push(this.set(() => this.kick(), RESTART_EVERY_MS));
  }

  private clearAll(): void {
    this.timers.forEach((t) => this.clear(t));
    this.timers = [];
  }
}

/**
 * The relay path for an ICE restart when the chat channel is down too (the relays reach both sides).
 * hub.ts registers here; a Peer that makes a restart offer while reconnecting hands it over.
 */
type RescueHook = (p: Peer, offer: RTCSessionDescriptionInit) => void;
const rescueHooks = new Set<RescueHook>();
export function onRescue(fn: RescueHook): () => void {
  rescueHooks.add(fn);
  return () => rescueHooks.delete(fn);
}
/** A connection that was ready ended by itself (network, or reconnecting gave up), not by close(). */
type LostHook = (p: Peer) => void;
const lostHooks = new Set<LostHook>();
export function onLost(fn: LostHook): () => void {
  lostHooks.add(fn);
  return () => lostHooks.delete(fn);
}
/** Ready connections, to find the one a relay restart offer is for (by both link fingerprints). */
const livePeers = new Set<Peer>();
export function findPeer(myFingerprint: string, theirFingerprint: string): Peer | undefined {
  for (const p of livePeers) if (p.fingerprints.mine === myFingerprint && p.fingerprints.theirs === theirFingerprint) return p;
  return undefined;
}
/** Is there a ready connection to this identity key (base64url)? */
export function hasLivePeer(publicKey: string): boolean {
  for (const p of livePeers) if (p.ready && p.peer && toB64url(p.peer.publicKey) === publicKey) return true;
  return false;
}

type Wire =
  | { k: 'hello'; id: string; v?: number; f?: string[]; dc?: DeviceCert; dp?: string }
  | { k: 'msg'; mid: string; text: string; ts: number }
  | { k: 'ping' }
  | { k: 'pong' }
  | { k: 'bye' }
  | { k: 'back' }
  | { k: 'sdp'; d: RTCSessionDescriptionInit }
  | { k: 'ice'; c: RTCIceCandidateInit | null }
  | { k: 'call'; cid: string; video: boolean }
  | { k: 'ring'; cid: string }
  | { k: 'accept'; cid: string }
  | { k: 'decline'; cid: string }
  | { k: 'busy'; cid: string }
  | { k: 'media-failed'; cid: string }
  | { k: 'hangup'; cid: string }
  | { k: 'rec'; cid: string; on: boolean }
  | { k: 'screen'; cid: string; on: boolean }
  | { k: 'devs'; l: { c: DeviceCert; s: number }[] };

/** Frame kinds this build acts on after hello; anything else is ignored (never fatal). */
const CALL_KINDS = new Set(['call', 'ring', 'accept', 'decline', 'busy', 'media-failed', 'hangup', 'rec', 'screen']);

function waitForGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(t);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const t = setTimeout(done, GATHER_LIMIT_MS); // use what we have; no trickle needed
    pc.addEventListener('icegatheringstatechange', check);
  });
}

const randomId = () => toB64url(crypto.getRandomValues(new Uint8Array(9)));

/** Ring timeout; tests can shorten it with ?ring=3000 */
export function ringTimeoutMs(): number {
  const v = Number(testFlag('ring'));
  return v > 0 ? v : 45000;
}

export class Peer {
  readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private lock: SessionLock | null = null;
  private ephemeral = newEphemeral();
  private myFingerprint = '';
  private remote: VerifiedCode | null = null;
  /** Received frames, opened one at a time in arrival order; one failing frame doesn't stop the rest. */
  private inbox = new SerialQueue((e) => console.warn('P2P Talk: a received message failed', e));
  /** Sent frames, locked and sent one at a time, so their counters go out in order. */
  private outbox = new SerialQueue((e) => console.warn('P2P Talk: a message could not be sent', e));
  private finished = false;
  private isReady = false;
  private listeners = new Map<keyof PeerEvents, ((...a: unknown[]) => void)[]>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastHeard = 0;
  private online = false;
  /** They said 'bye' (app hidden or closed): offline now, until 'back' or a message (PROTOCOL.md). */
  private theyAreAway = false;
  private lastPathKey = '';
  /** The latest connection path (for screens opened after the event). */
  path: PathInfo = { kind: 'offline', networkType: '' };
  private closedOnce = false;
  /** close() was called (by the app, or after a frame that did not open): not a network loss. */
  private endedByMe = false;
  /** ICE restart watch (BUG-8), active once the connection is ready. */
  private readonly link: LinkWatch;
  /** 'reconnecting' while the network under this connection is being restarted. */
  linkState: 'up' | 'reconnecting' = 'up';
  /**
   * Set when this is a "group member" link (the hub connected us as members of this group, not as
   * contacts): the app shows no chat for it unless they are a contact, and files ask first.
   */
  memberOf?: string;
  /** The call state to go back to after reconnecting. */
  private resumeCall: CallState | null = null;
  peer: PeerInfo | null = null;

  // perfect negotiation (for calls)
  private makingOffer = false;
  private ignoreOffer = false;
  private readonly polite: boolean;

  // calls
  call: CallInfo = { state: 'idle', video: false, outgoing: false };
  private callId = '';
  localStream: MediaStream | null = null;
  remoteStream: MediaStream | null = null;
  private callTimers: ReturnType<typeof setTimeout>[] = [];
  private iceUp = false;
  /** The other side is recording the current call. */
  theyRecord = false;
  private iRecord = false;
  /** Set by the owner: true while another connection on this device has a call (then reply busy). */
  otherCallBusy: () => boolean = () => false;
  /** What this connection attempt did (Connection details). */
  readonly diag: Attempt;
  /** My screen share track while sharing; they share their screen. */
  private shareTrack: MediaStreamTrack | null = null;
  theyShare = false;
  /** While sharing with device sound: mic + device sound mixed into one outgoing audio track. */
  private mix: { ctx: AudioContext; mic: GainNode; device: GainNode; deviceTrack: MediaStreamTrack; out: MediaStreamTrack; micTrack: MediaStreamTrack | null } | null = null;
  private micOn = true;
  private deviceSoundOn = true;

  private constructor(
    private readonly me: Me,
    readonly role: 'offerer' | 'answerer',
  ) {
    this.polite = role === 'answerer';
    this.diag = beginAttempt(role === 'offerer' ? 'I made the offer' : 'I answered their offer');
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' });
    const d = this.diag;
    this.pc.addEventListener('icegatheringstatechange', () => note(d, `iceGatheringState ${this.pc.iceGatheringState}`));
    this.pc.addEventListener('iceconnectionstatechange', () => note(d, `iceConnectionState ${this.pc.iceConnectionState}`));
    this.pc.addEventListener('connectionstatechange', () => note(d, `connectionState ${this.pc.connectionState}`));
    // The chat channel is "p2ptalk"; "file:<id>" channels each carry one file transfer (never the chat).
    this.pc.addEventListener('datachannel', (e) => {
      if (e.channel.label.startsWith(FILE_CHANNEL_PREFIX)) {
        const id = this.peer?.id ?? '';
        void rtcBinaryChannel(e.channel, id).then((ch) => this.emit('fileChannel', ch)).catch(() => undefined);
        return;
      }
      if (this.dc) {
        // A second chat channel (a buggy or hostile peer): never swap the chat channel under a live connection.
        try {
          e.channel.close();
        } catch {
          /* ignore */
        }
        return;
      }
      this.attach(e.channel);
    });
    this.pc.addEventListener('negotiationneeded', () => void this.renegotiate());
    this.pc.addEventListener('icecandidate', (e) => {
      if (this.isReady) void this.send({ k: 'ice', c: e.candidate ? e.candidate.toJSON() : null });
    });
    this.pc.addEventListener('track', (e) => this.onTrack(e));
    this.link = new LinkWatch({
      restart: (n) => this.restartIce(n),
      change: (st) => this.onLinkChange(st),
      giveUp: () => {
        note(this.diag, `reconnecting did not work within ${RECONNECT_GIVE_UP_MS / 1000} s`);
        this.shutdown();
      },
    });
    this.pc.addEventListener('iceconnectionstatechange', () => {
      const s = this.pc.iceConnectionState;
      this.iceUp = s === 'connected' || s === 'completed';
      if (this.isReady) this.link.ice(s);
      this.checkCallConnected();
    });
    this.pc.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      // Once ready, an ICE failure is restarted (LinkWatch), not the end; before that, whenReady() decides.
      if (s === 'closed' || (s === 'failed' && (!this.isReady || this.pc.sctp?.transport.state === 'failed'))) this.onDisconnected();
    });
  }

  /** My and their link (DTLS) fingerprints, as signed in the two codes. */
  get fingerprints(): { mine: string; theirs: string } {
    return { mine: this.myFingerprint, theirs: this.remote?.fingerprint ?? '' };
  }

  /** The connection ended by itself (network), not by close(): the app may reconnect quietly. */
  get lost(): boolean {
    return this.closedOnce && !this.endedByMe;
  }

  // ---- ICE restart (BUG-8) -------------------------------------------------------------------------

  private onLinkChange(st: 'up' | 'reconnecting'): void {
    this.linkState = st;
    note(this.diag, st === 'up' ? 'link back up' : 'link stalled: reconnecting');
    if (st === 'reconnecting') {
      if (this.call.state === 'connected' || this.call.state === 'connecting') {
        this.resumeCall = this.call.state;
        // The media timeout armed for 'connecting' must not fire into the resumed call: a fresh one is armed when the link is back.
        this.clearCallTimers();
        this.setCall({ state: 'reconnecting' });
      }
    } else {
      void this.checkLinkIdentity();
      if (this.call.state === 'reconnecting') {
        const back = this.resumeCall === 'connected' ? 'connected' : 'connecting';
        this.resumeCall = null;
        this.setCall({ state: back });
        if (back === 'connecting') {
          this.armMediaTimeout();
          this.checkCallConnected();
        }
      }
    }
    this.emit('link', st);
  }

  /** An ICE restart: over the locked chat channel (perfect negotiation), and through the relays (hub). */
  private restartIce(attempt: number): void {
    if (!this.ready) return;
    note(this.diag, `ICE restart, try ${attempt}`);
    if (this.pc.signalingState === 'stable') this.pc.restartIce(); // -> negotiationneeded -> renegotiate()
    else if (this.pc.signalingState === 'have-local-offer' && this.pc.localDescription) void this.rescue();
  }

  /** Hands my current restart offer to the relay path (the chat channel may be down with the network). */
  private async rescue(): Promise<void> {
    if (!rescueHooks.size) return;
    await waitForGathering(this.pc); // the relays carry no trickled candidates: put them in the offer
    const d = this.pc.localDescription;
    if (this.linkState !== 'reconnecting' || this.pc.signalingState !== 'have-local-offer' || d?.type !== 'offer') return;
    const offer = d.toJSON();
    for (const fn of rescueHooks) fn(this, offer);
  }

  /**
   * A restart offer that came through the relays (hub). The link fingerprint must be the one their
   * identity key signed. Returns my answer (with candidates), or null (refused, or my own offer wins).
   */
  rescueOffer(d: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit | null> {
    return this.inbox.run(async () => {
      if (!this.ready || !this.remote || d?.type !== 'offer' || typeof d.sdp !== 'string') return null;
      if (sdpFingerprint(d.sdp) !== this.remote.fingerprint) return null;
      if (this.pc.remoteDescription?.sdp === d.sdp) {
        // The same offer again (repeated on the relays, or it came over the chat channel first).
        const mine = this.pc.localDescription;
        return mine?.type === 'answer' ? mine.toJSON() : null;
      }
      const collision = this.makingOffer || this.pc.signalingState !== 'stable';
      if (collision && !this.polite) return null; // my own restart offer wins; they take it
      await this.pc.setRemoteDescription(d);
      await this.pc.setLocalDescription();
      await waitForGathering(this.pc);
      note(this.diag, 'ICE restart answered through the relays');
      return this.pc.localDescription?.toJSON() ?? null;
    });
  }

  /** Their answer to my restart offer, through the relays. */
  rescueAnswer(d: RTCSessionDescriptionInit, forOffer: string): Promise<void> {
    return this.inbox.run(async () => {
      if (!this.remote || d?.type !== 'answer' || typeof d.sdp !== 'string') return;
      if (this.pc.signalingState !== 'have-local-offer' || this.pc.localDescription?.sdp !== forOffer) return;
      if (sdpFingerprint(d.sdp) !== this.remote.fingerprint) return;
      await this.pc.setRemoteDescription(d);
      note(this.diag, 'ICE restart answer came through the relays');
    });
  }

  /**
   * After a restart: the DTLS certificate in use must still be the one their identity key signed
   * (an ICE restart keeps DTLS, so it should be; anything else closes the connection).
   */
  private async checkLinkIdentity(): Promise<void> {
    try {
      const stats = await this.pc.getStats();
      let certId = '';
      stats.forEach((r) => {
        if (r.type === 'transport' && r.remoteCertificateId) certId = r.remoteCertificateId;
      });
      const cert = certId ? stats.get(certId) : undefined;
      if (!cert?.fingerprint || !cert.fingerprintAlgorithm) return;
      const fp = `${String(cert.fingerprintAlgorithm).toLowerCase()} ${String(cert.fingerprint).toUpperCase()}`;
      if (this.remote && fp !== this.remote.fingerprint) {
        note(this.diag, 'link fingerprint changed after a restart: closed');
        this.close();
      }
    } catch {
      /* closed */
    }
  }

  on<K extends keyof PeerEvents>(k: K, fn: PeerEvents[K]): this {
    const list = this.listeners.get(k) ?? [];
    list.push(fn as (...a: unknown[]) => void);
    this.listeners.set(k, list);
    return this;
  }

  off<K extends keyof PeerEvents>(k: K, fn: PeerEvents[K]): this {
    this.listeners.set(k, (this.listeners.get(k) ?? []).filter((x) => x !== fn));
    return this;
  }

  // ---- channels for the file and group engines (docs/INTEGRATION_FILES_GROUPS.md) -----------------

  /** Sends a file / group control frame, locked, in order with every other frame. */
  sendFrame(f: object): Promise<void> {
    return this.send(f as Wire);
  }

  /** The locked chat channel as a Channel (JSON frames). */
  chatChannel(): Channel {
    return {
      peerId: this.peer!.id,
      send: (f) => this.sendFrame(f as object),
      onFrame: (cb) => {
        const fn = (f: object) => cb(f);
        this.on('frame', fn);
        return () => this.off('frame', fn);
      },
    };
  }

  /** A new data channel for one file transfer (no renegotiation needed on an open connection). */
  async openFileChannel(id: string): Promise<Channel> {
    const dc = this.pc.createDataChannel(`${FILE_CHANNEL_PREFIX}${id}`, { ordered: true });
    const ch = await rtcBinaryChannel(dc, this.peer!.id);
    if (!FILE_DELAY_MS) return ch;
    const send = ch.send.bind(ch);
    return { ...ch, peerId: ch.peerId, send: async (f) => { await new Promise((r) => setTimeout(r, FILE_DELAY_MS)); await send(f); } };
  }

  /** The largest data-channel message this connection takes (for file frames). */
  get maxFrame(): number {
    return Math.min(this.pc.sctp?.maxMessageSize || 65536, 262144);
  }

  private emit<K extends keyof PeerEvents>(k: K, ...args: Parameters<PeerEvents[K]>): void {
    // A copy: a listener may add listeners (they then hear the next event, not this one).
    for (const fn of [...(this.listeners.get(k) ?? [])]) fn(...args);
  }

  // ---- Making the connection --------------------------------------------------------------

  /**
   * Make the offer code. `bind` (one-scan connect: "box:<box id>") is added to what is signed, so
   * the offer only counts for that one reply box.
   */
  static async start(me: Me, bind = ''): Promise<{ peer: Peer; code: string }> {
    const p = new Peer(me, 'offerer');
    p.attach(p.pc.createDataChannel('p2ptalk', { ordered: true }));
    await p.pc.setLocalDescription(await p.pc.createOffer());
    await waitForGathering(p.pc);
    const sdp = withoutCandidates(p.pc.localDescription!.sdp);
    p.diag.local = summarize(p.pc.localDescription!.sdp);
    p.myFingerprint = sdpFingerprint(sdp);
    const code = makeCode({
      kind: 'offer',
      sdp,
      identitySecret: me.secretKey,
      identityPublic: me.publicKey,
      ephemeralPublic: p.ephemeral.public,
      name: me.name,
      peerFingerprint: bind,
    });
    return { peer: p, code: await encodeCode(code) };
  }

  /** Device B: read their code, check its signature, and make the reply code. */
  static async reply(me: Me, theirCode: string, bind = ''): Promise<{ peer: Peer; code: string }> {
    const remote = verifyCode(await decodeCode(theirCode), 'offer', bind);
    if (p2pId(remote.identityKey) === p2pId(me.publicKey)) throw new Error('This is your own code. Scan the other device.');
    const p = new Peer(me, 'answerer');
    p.remote = remote;
    p.diag.remote = summarize(remote.sdp);
    await p.pc.setRemoteDescription({ type: 'offer', sdp: remote.sdp });
    await p.pc.setLocalDescription(await p.pc.createAnswer());
    await waitForGathering(p.pc);
    const sdp = withoutCandidates(p.pc.localDescription!.sdp);
    p.diag.local = summarize(p.pc.localDescription!.sdp);
    note(p.diag, 'answer made');
    p.myFingerprint = sdpFingerprint(sdp);
    const code = makeCode({
      kind: 'answer',
      sdp,
      identitySecret: me.secretKey,
      identityPublic: me.publicKey,
      ephemeralPublic: p.ephemeral.public,
      name: me.name,
      peerFingerprint: remote.fingerprint,
    });
    await p.makeLock();
    return { peer: p, code: await encodeCode(code) };
  }

  /** Device A: read their reply code and connect. */
  async finish(theirReply: string, expectIdentity?: Uint8Array): Promise<void> {
    // Only the first reply counts (several devices of the same person may answer one offer).
    if (this.finished) throw new Error('already answered');
    const remote = verifyCode(await decodeCode(theirReply), 'answer', this.myFingerprint);
    if (this.finished) throw new Error('already answered');
    // The whole key, not only the 24-digit ID (76 bits).
    if (expectIdentity && toB64url(expectIdentity) !== toB64url(remote.identityKey)) {
      throw new Error('Safety check failed: the reply is not from the person whose code you scanned.');
    }
    if (p2pId(remote.identityKey) === p2pId(this.me.publicKey)) throw new Error('This is your own code.');
    this.finished = true;
    this.remote = remote;
    this.diag.remote = summarize(remote.sdp);
    note(this.diag, 'answer received');
    await this.makeLock();
    await this.pc.setRemoteDescription({ type: 'answer', sdp: remote.sdp });
  }

  /**
   * Resolves when the direct connection is open and both hellos are in. Rejects with ConnectFailed
   * when it fails or doesn't open within `ms` (20 s). Call after the answer is in.
   */
  whenReady(ms = CONNECT_WAIT_MS): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let done = false;
      const end = (err?: ConnectFailed) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        this.pc.removeEventListener('connectionstatechange', watch);
        if (err) {
          this.diag.error = err.why === 'timeout' ? `not connected after ${Math.round(ms / 1000)} s (ICE ${this.pc.iceConnectionState})` : `connection ${err.why}`;
          note(this.diag, this.diag.error);
          reject(err);
        } else resolve();
      };
      const watch = () => this.pc.connectionState === 'failed' && end(new ConnectFailed('failed'));
      const t = setTimeout(() => end(new ConnectFailed('timeout')), ms);
      this.pc.addEventListener('connectionstatechange', watch);
      this.on('ready', () => end()).on('closed', () => end(new ConnectFailed(this.pc.iceConnectionState === 'failed' ? 'failed' : 'closed')));
    });
  }

  /** The selected candidate pair, masked, for Connection details. */
  private async notePair(): Promise<void> {
    try {
      const stats = await this.pc.getStats();
      let pairId = '';
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      });
      let pair: { localCandidateId?: string; remoteCandidateId?: string } | undefined;
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && (r.id === pairId || (!pairId && (r.selected || (r.nominated && r.state === 'succeeded'))))) pair = r;
      });
      if (!pair) return;
      const l = stats.get(pair.localCandidateId!);
      const r = stats.get(pair.remoteCandidateId!);
      const side = (c: { candidateType?: string; address?: string; ip?: string; protocol?: string } | undefined) =>
        c ? `${c.candidateType} ${mask(c.address ?? c.ip)} ${c.protocol ?? ''}`.trim() : '?';
      this.diag.pair = `${side(l)} ↔ ${side(r)}`;
    } catch {
      /* closed */
    }
  }

  private async makeLock(): Promise<void> {
    const r = this.remote!;
    const offerer = this.role === 'offerer';
    this.lock = await SessionLock.create({
      role: this.role,
      myIdentitySecret: this.me.secretKey,
      myIdentityPublic: this.me.publicKey,
      myEphemeralSecret: this.ephemeral.secret,
      myEphemeralPublic: this.ephemeral.public,
      peerIdentityPublic: r.identityKey,
      peerEphemeralPublic: r.ephemeralKey,
      offerFingerprint: offerer ? this.myFingerprint : r.fingerprint,
      answerFingerprint: offerer ? r.fingerprint : this.myFingerprint,
    });
    this.ephemeral.secret.fill(0);
    this.peer = { id: p2pId(r.identityKey), publicKey: r.identityKey, name: r.name, version: 0, features: [] };
  }

  /** The first frame: who I am, which version and features I speak, and this device. */
  private hello(): Wire {
    const w: Wire = { k: 'hello', id: p2pId(this.me.publicKey), v: PROTOCOL_VERSION, f: [...FEATURES] };
    const d = this.me.device;
    if (d && this.remote) {
      w.dc = d.cert;
      w.dp = deviceProof(d.secretKey, this.myFingerprint, this.remote.fingerprint);
    }
    return w;
  }

  /** Their hello: version, features and (if valid) their device. An invalid device part is just left out. */
  private readHello(w: Extract<Wire, { k: 'hello' }>): void {
    const p = this.peer!;
    p.version = typeof w.v === 'number' ? w.v : 0;
    p.features = Array.isArray(w.f) ? w.f.filter((x) => typeof x === 'string').slice(0, 64) : [];
    if (w.dc && this.remote) {
      const info = verifyCert(p.publicKey, w.dc);
      if (info && verifyDeviceProof(info.key, w.dp, this.remote.fingerprint, this.myFingerprint)) p.device = { ...info, cert: w.dc };
    }
  }

  private attach(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => void this.send(this.hello(), true);
    dc.onmessage = (e) => {
      const frame = new Uint8Array(e.data as ArrayBuffer);
      this.inbox.push(() => this.receive(frame));
    };
    dc.onclose = () => this.onDisconnected();
  }

  // ---- Locked messages ------------------------------------------------------------------------

  /** Locks and sends one frame. Queued: frames leave in counter order even when sealing takes different times. */
  private send(w: Wire, beforeReady = false): Promise<void> {
    return this.outbox.run(async () => {
      if (!this.lock || !this.dc || this.dc.readyState !== 'open' || (!this.isReady && !beforeReady)) return;
      const frame = await this.lock.seal(utf8(JSON.stringify(w)));
      if (this.dc.readyState === 'open') this.dc.send(frame as Uint8Array<ArrayBuffer>);
    }).catch(() => undefined); // already reported by the queue; the next frames still go
  }

  private async receive(frame: Uint8Array): Promise<void> {
    let w: Wire;
    try {
      w = JSON.parse(fromUtf8(await this.lock!.open(frame))) as Wire;
    } catch {
      // A message that doesn't open with our key: someone else, changed, or replayed. Drop the link.
      this.close();
      return;
    }
    this.lastHeard = Date.now();
    if (!this.isReady) {
      if (w.k === 'hello' && w.id === this.peer?.id) {
        this.readHello(w);
        this.isReady = true;
        this.diag.ok = true;
        note(this.diag, `connected (their protocol ${this.peer!.version}, ${this.peer!.features.length} features)`);
        void this.notePair();
        this.startTimers();
        livePeers.add(this);
        this.emit('ready', this.peer!);
        this.updatePresence();
      } else this.close();
      return;
    }
    switch (w.k) {
      case 'msg':
        if (this.theyAreAway) {
          this.theyAreAway = false;
          this.updatePresence();
        }
        if (typeof w.text === 'string') this.emit('message', { mid: w.mid, text: w.text.slice(0, 20000), ts: w.ts });
        break;
      case 'ping':
        void this.send({ k: 'pong' });
        break;
      case 'pong':
        break;
      case 'bye':
        this.theyAreAway = true;
        this.updatePresence();
        break;
      case 'back':
        this.theyAreAway = false;
        this.updatePresence();
        break;
      case 'sdp':
        await this.onRemoteDescription(w.d);
        break;
      case 'ice':
        try {
          await this.pc.addIceCandidate(w.c ?? undefined);
        } catch (e) {
          if (!this.ignoreOffer) console.warn('ice', e);
        }
        break;
      case 'devs':
        if (Array.isArray(w.l)) this.emit('devices', w.l.slice(0, 20));
        break;

      default:
        // Files (files2) and groups go to their engines; call messages; any other kind is ignored.
        if (FILE_KINDS.has(w.k) || GROUP_KINDS.has(w.k) || GROUP_CALL_KINDS.has(w.k) || PIC_KINDS.has(w.k) || RCPT_KINDS.has(w.k)) this.emit('frame', w);
        else if (CALL_KINDS.has(w.k)) this.onCallSignal(w);
    }
  }

  /** Does the other side understand this feature (from its hello)? */
  supports(feature: string): boolean {
    return this.peer?.features.includes(feature) ?? false;
  }

  /** Tell them which of their other devices I have seen (multi-device; ignored by older builds). */
  async sendDevices(list: { c: DeviceCert; s: number }[]): Promise<void> {
    if (this.ready && list.length) await this.send({ k: 'devs', l: list.slice(0, 20) });
  }

  get ready(): boolean {
    return this.isReady && this.dc?.readyState === 'open';
  }

  /** A call is being set up or is on (not idle, ended, failed or missed). */
  get inCallNow(): boolean {
    return this.inCall();
  }

  /** Tell them I'm away (page hidden or closing: 'bye') or back ('back'). Ignored by older builds. */
  async setAway(away: boolean): Promise<void> {
    if (this.ready) await this.send({ k: away ? 'bye' : 'back' });
  }

  async sendText(text: string): Promise<{ mid: string; ts: number }> {
    const m = { k: 'msg' as const, mid: randomId(), text, ts: Date.now() };
    if (!this.ready) throw new Error('offline');
    await this.send(m);
    return m;
  }

  // ---- Online / offline and path -----------------------------------------------------------------

  private startTimers(): void {
    this.timers.push(setInterval(() => void this.send({ k: 'ping' }), HEARTBEAT_MS));
    this.timers.push(setInterval(() => this.updatePresence(), 1000));
    const poll = () => void this.updatePath();
    poll();
    this.timers.push(setInterval(poll, 3000));
  }

  private updatePresence(): void {
    const online = this.ready && !this.theyAreAway && Date.now() - this.lastHeard < ONLINE_WINDOW_MS;
    if (online !== this.online) {
      this.online = online;
      this.emit('presence', online, this.lastHeard);
      if (!online) this.setOfflinePath();
      else void this.updatePath();
    }
  }

  get isOnline(): boolean {
    return this.online;
  }

  get lastSeen(): number {
    return this.lastHeard;
  }

  private setOfflinePath(): void {
    this.lastPathKey = '';
    this.path = { kind: 'offline', networkType: '' };
    this.emit('path', this.path);
  }

  private async updatePath(): Promise<void> {
    if (!this.online) return;
    try {
      const p = pathFromStats(await this.pc.getStats());
      const key = p.kind + p.networkType;
      if (key !== this.lastPathKey) {
        this.lastPathKey = key;
        this.path = p;
        this.emit('path', p);
      }
    } catch {
      /* closed */
    }
  }

  private onDisconnected(): void {
    this.link.stop();
    livePeers.delete(this);
    if (this.call.state !== 'idle' && this.call.state !== 'ended' && this.call.state !== 'failed' && this.call.state !== 'missed') {
      // The link dropped while it rang on my side: a missed call (not "declined by you" in Calls).
      this.endCall(this.call.state === 'reaching' || this.call.state === 'ringing' ? 'failed' : this.call.state === 'incoming' ? 'missed' : 'ended', 'offline');
    }
    this.updatePresence();
    this.setOfflinePath();
    if (!this.closedOnce) {
      const wasReady = this.isReady;
      this.closedOnce = true;
      this.emit('closed');
      if (wasReady && !this.endedByMe) for (const fn of lostHooks) fn(this);
    }
  }

  close(): void {
    this.endedByMe = true;
    this.shutdown();
  }

  /** Closes everything (close(), or reconnecting gave up: then it counts as lost). */
  private shutdown(): void {
    try {
      this.dc?.close();
    } catch {
      /* ignore */
    }
    this.pc.close();
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.onDisconnected();
  }

  // ---- Renegotiation over the locked data channel (perfect negotiation pattern) -----------------

  private async renegotiate(): Promise<void> {
    if (!this.ready) return; // the first negotiation is the QR / text exchange
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      const d = this.pc.localDescription!.toJSON();
      if (!(RESTART_VIA_RELAYS_ONLY && this.linkState === 'reconnecting')) await this.send({ k: 'sdp', d });
      // While reconnecting the chat channel may be down too: the relays carry the offer as well.
      if (this.linkState === 'reconnecting' && d.type === 'offer') void this.rescue();
    } catch (e) {
      console.warn('renegotiate', e);
    } finally {
      this.makingOffer = false;
    }
  }

  private async onRemoteDescription(d: RTCSessionDescriptionInit): Promise<void> {
    // The link fingerprint must stay the one their identity key signed.
    if (d.sdp && sdpFingerprint(d.sdp) !== this.remote?.fingerprint) {
      this.close();
      return;
    }
    // A restart offer / answer that already came through the relays (BUG-8): nothing more to do.
    if (this.pc.signalingState === 'stable' && (d.type === 'answer' || (d.type === 'offer' && this.pc.remoteDescription?.sdp === d.sdp))) return;
    const collision = d.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) return;
    await this.pc.setRemoteDescription(d);
    if (d.type === 'offer') {
      // Caller side of a call: attach our camera/mic to the transceivers their offer created.
      if (this.localStream && this.call.state === 'connecting') this.attachLocalTracks();
      await this.pc.setLocalDescription();
      await this.send({ k: 'sdp', d: this.pc.localDescription!.toJSON() });
    }
  }

  // ---- Calls ------------------------------------------------------------------------------------------

  private setCall(c: Partial<CallInfo>): void {
    this.call = { ...this.call, ...c };
    this.emit('call', { ...this.call });
  }

  private clearCallTimers(): void {
    this.callTimers.forEach(clearTimeout);
    this.callTimers = [];
  }

  private inCall(): boolean {
    return !['idle', 'ended', 'failed', 'missed'].includes(this.call.state);
  }

  /**
   * Opens the camera / microphone for the current call. Resolves null when that call ended while the
   * permission prompt was open (hang-up, or the link dropped): the devices are let go at once, and
   * nothing more is sent for it.
   */
  private async getMedia(video: boolean): Promise<MediaStream | null> {
    const cid = this.callId;
    // The camera and microphone picked last time (call › Devices), else the front camera.
    const s = await openChosen((c) => navigator.mediaDevices.getUserMedia(c), true, video ? {} : false);
    if (this.callId !== cid || !this.inCall()) {
      s.getTracks().forEach((t) => t.stop());
      return null;
    }
    this.localStream = s;
    this.emit('localStream', s);
    return s;
  }

  private attachLocalTracks(): void {
    const s = this.localStream;
    if (!s) return;
    const used = new Set(this.pc.getSenders().map((x) => x.track));
    for (const t of s.getTracks()) if (!used.has(t)) this.pc.addTrack(t, s);
  }

  /** Caller: "Video call" / "Voice call". */
  async startCall(video: boolean): Promise<void> {
    if (this.inCall()) return;
    this.callId = randomId();
    this.iceUp = ['connected', 'completed'].includes(this.pc.iceConnectionState);
    this.setCall({ state: 'reaching', video, outgoing: true, failure: undefined, connectedAt: undefined });
    if (!this.ready || !this.online) {
      this.endCall('failed', 'offline');
      return;
    }
    try {
      if (!(await this.getMedia(video))) return; // cancelled (or the link dropped) while the prompt was open
    } catch {
      if (this.call.state === 'reaching') this.endCall('failed', 'my-media');
      return;
    }
    await this.send({ k: 'call', cid: this.callId, video });
    this.callTimers.push(
      setTimeout(() => {
        if (this.call.state === 'reaching') this.endCall('failed', 'offline', true);
      }, REACH_TIMEOUT_MS),
    );
  }

  /** Callee: Accept. */
  async acceptCall(): Promise<void> {
    if (this.call.state !== 'incoming') return;
    this.clearCallTimers();
    this.setCall({ state: 'connecting' });
    const cid = this.callId;
    try {
      if (!(await this.getMedia(this.call.video))) return; // the caller hung up (or the link dropped) while the prompt was open
    } catch {
      if (this.callId !== cid || !this.inCall()) return; // that call ended meanwhile
      await this.send({ k: 'media-failed', cid: this.callId });
      this.endCall('failed', 'my-media');
      return;
    }
    await this.send({ k: 'accept', cid: this.callId });
    this.attachLocalTracks(); // -> negotiationneeded -> offer over the data channel
    this.armMediaTimeout();
  }

  /** Callee: Decline. */
  async declineCall(): Promise<void> {
    if (this.call.state !== 'incoming') return;
    await this.send({ k: 'decline', cid: this.callId });
    this.endCall('ended');
  }

  /** Either side: Hang up (also cancels a call that is still ringing). */
  async hangUp(): Promise<void> {
    if (!this.inCall()) return;
    await this.send({ k: 'hangup', cid: this.callId });
    this.endCall('ended', undefined, false, true);
  }

  setMicOn(on: boolean): void {
    this.micOn = on;
    // While device sound is mixed in, mic off mutes only the mic: the device sound keeps going.
    if (this.mix) this.mix.mic.gain.value = on ? 1 : 0;
    else this.localStream?.getAudioTracks().forEach((t) => (t.enabled = on));
  }

  setCameraOn(on: boolean): void {
    this.localStream?.getVideoTracks().forEach((t) => (t.enabled = on));
  }

  private armMediaTimeout(): void {
    this.callTimers.push(
      setTimeout(() => {
        if (this.call.state === 'connecting') {
          void this.send({ k: 'hangup', cid: this.callId });
          this.endCall('failed', 'media', false, true);
        }
      }, MEDIA_TIMEOUT_MS),
    );
  }

  private onCallSignal(w: Wire): void {
    if (!('cid' in w)) return;
    if (w.k === 'call') {
      // Busy only for a call on THIS device (another device of mine being connected never counts).
      if (this.inCall() || this.otherCallBusy()) {
        void this.send({ k: 'busy', cid: w.cid });
        return;
      }
      this.callId = w.cid;
      this.iceUp = ['connected', 'completed'].includes(this.pc.iceConnectionState);
      this.setCall({ state: 'incoming', video: w.video, outgoing: false, failure: undefined, connectedAt: undefined });
      void this.send({ k: 'ring', cid: w.cid }); // ring-ack: the incoming call is on screen
      this.callTimers.push(
        setTimeout(() => {
          if (this.call.state === 'incoming') this.endCall('missed');
        }, ringTimeoutMs() + 5000),
      );
      return;
    }
    if (w.cid !== this.callId) return;
    switch (w.k) {
      case 'ring':
        if (this.call.state === 'reaching') {
          this.clearCallTimers();
          this.setCall({ state: 'ringing' });
          this.callTimers.push(
            setTimeout(() => {
              if (this.call.state === 'ringing') this.endCall('failed', 'no-answer', true);
            }, ringTimeoutMs()),
          );
        }
        break;
      case 'accept':
        if (this.call.state === 'reaching' || this.call.state === 'ringing') {
          this.clearCallTimers();
          this.setCall({ state: 'connecting' });
          this.armMediaTimeout();
        }
        break;
      case 'decline':
        if (this.call.outgoing) this.endCall('failed', 'declined');
        break;
      case 'busy':
        if (this.call.outgoing) this.endCall('failed', 'busy');
        break;
      case 'media-failed':
        if (this.call.outgoing) this.endCall('failed', 'their-media');
        break;
      case 'hangup':
        this.endCall(this.call.state === 'incoming' ? 'missed' : 'ended');
        break;
      case 'screen':
        if (this.inCall() && this.theyShare !== !!w.on) {
          this.theyShare = !!w.on;
          this.emitScreen();
        }
        break;
      case 'rec':
        if (this.inCall() && this.theyRecord !== !!w.on) {
          this.theyRecord = !!w.on;
          this.emit('recording', this.theyRecord);
        }
        break;
    }
  }

  // ---- screen sharing ------------------------------------------------------------------------------

  /** My screen goes out instead of my camera (same video sender, no renegotiation when there is one). */
  async startScreenShare(): Promise<void> {
    if (!this.inCall() || this.shareTrack) return;
    if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') throw new Error('This browser can’t share the screen.');
    // Ask for the device's sound too (Chrome offers "Also share system / tab audio"; Safari and Firefox give none).
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    } as DisplayMediaStreamOptions);
    const t = s.getVideoTracks()[0];
    if (!t) return;
    this.shareTrack = t;
    t.addEventListener('ended', () => void this.stopScreenShare()); // stopped from the browser's own bar
    await this.replaceVideoTrack(t);
    const sound = s.getAudioTracks()[0];
    if (sound) await this.mixDeviceSound(sound);
    await this.send({ k: 'screen', cid: this.callId, on: true });
    this.emitScreen();
  }

  private emitScreen(): void {
    this.emit('screen', { mine: !!this.shareTrack, theirs: this.theyShare, sound: !!this.mix && this.deviceSoundOn, soundCaptured: !!this.mix });
  }

  private audioSender(): RTCRtpSender | undefined {
    return this.pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio' && t.direction !== 'stopped' && t.currentDirection !== 'stopped')?.sender;
  }

  /** Device sound + my microphone → one track (WebAudio), swapped in on the same sender (no renegotiation). */
  private async mixDeviceSound(deviceTrack: MediaStreamTrack): Promise<void> {
    const sender = this.audioSender();
    if (!sender) {
      deviceTrack.stop();
      return;
    }
    const ctx = new AudioContext();
    await ctx.resume().catch(() => undefined);
    const dest = ctx.createMediaStreamDestination();
    const mic = ctx.createGain();
    const device = ctx.createGain();
    const micTrack = this.localStream?.getAudioTracks()[0] ?? null; // keeps its echo cancellation / noise suppression
    if (micTrack) ctx.createMediaStreamSource(new MediaStream([micTrack])).connect(mic);
    ctx.createMediaStreamSource(new MediaStream([deviceTrack])).connect(device); // no processing on device sound
    mic.connect(dest);
    device.connect(dest);
    mic.gain.value = this.micOn ? 1 : 0;
    device.gain.value = this.deviceSoundOn ? 1 : 0;
    const out = dest.stream.getAudioTracks()[0];
    if (micTrack) micTrack.enabled = true; // muting is the mic gain now, so device sound keeps going
    await sender.replaceTrack(out);
    this.mix = { ctx, mic, device, deviceTrack, out, micTrack };
  }

  private async unmix(): Promise<void> {
    const m = this.mix;
    if (!m) return;
    this.mix = null;
    if (m.micTrack) m.micTrack.enabled = this.micOn;
    await this.audioSender()?.replaceTrack(m.micTrack).catch(() => undefined);
    m.deviceTrack.stop();
    m.out.stop();
    void m.ctx.close().catch(() => undefined);
  }

  /** Device sound on / off while sharing (the pill's speaker button). */
  setScreenSound(on: boolean): void {
    this.deviceSoundOn = on;
    if (this.mix) this.mix.device.gain.value = on ? 1 : 0;
    this.emitScreen();
  }

  get screenSound(): { captured: boolean; on: boolean } {
    return { captured: !!this.mix, on: !!this.mix && this.deviceSoundOn };
  }

  /** Back to the camera. */
  async stopScreenShare(): Promise<void> {
    const t = this.shareTrack;
    if (!t) return;
    this.shareTrack = null;
    t.stop();
    await this.unmix(); // back to the plain microphone
    if (this.inCall()) {
      // Camera back and "screen off" at once, even if the camera track has ended (Android stops it in
      // the background); a fresh camera comes after, never blocking this (and not while hidden).
      await this.replaceVideoTrack(this.localStream?.getVideoTracks()[0] ?? null);
      await this.send({ k: 'screen', cid: this.callId, on: false });
      if (!globalThis.document?.hidden) void this.refreshCameraIfEnded();
    }
    this.emitScreen();
  }

  /**
   * Android cuts the camera off while the app is in the background (e.g. while sharing the screen):
   * the track ends. Get a fresh one (when sharing stops, or when the app is back in front).
   */
  async refreshCameraIfEnded(send = true): Promise<void> {
    const old = this.localStream?.getVideoTracks()[0];
    if (!old || old.readyState !== 'ended' || !this.inCall() || !this.call.video) return;
    if (globalThis.document?.hidden) return; // the app comes back to the front first (visibilitychange)
    try {
      // A stuck camera request (app in the background) must not block anything: give up after 3 s.
      let timedOut = false;
      const s = await new Promise<MediaStream>((resolve, reject) => {
        const timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('camera timeout'));
        }, 3000);
        openChosen((c) => navigator.mediaDevices.getUserMedia(c), false, {}).then(
          (got) => {
            clearTimeout(timer);
            if (timedOut) got.getTracks().forEach((x) => x.stop()); // too late: let that camera go
            else resolve(got);
          },
          (e) => {
            clearTimeout(timer);
            reject(e);
          },
        );
      });
      const t = s.getVideoTracks()[0];
      if (this.localStream?.getVideoTracks()[0] !== old) {
        t.stop(); // someone else already replaced it
        return;
      }
      t.enabled = old.enabled;
      this.localStream!.removeTrack(old);
      this.localStream!.addTrack(t);
      if (send && !this.shareTrack) await this.replaceVideoTrack(t);
      this.emit('localStream', this.localStream);
    } catch {
      /* no camera now: the call goes on with sound */
    }
  }

  get sharingScreen(): boolean {
    return !!this.shareTrack;
  }

  /** "I am recording this call": the other side shows "● <name> is recording". */
  async setRecording(on: boolean): Promise<void> {
    if (!this.inCall()) return;
    this.iRecord = on;
    await this.send({ k: 'rec', cid: this.callId, on });
  }

  get recording(): boolean {
    return this.iRecord;
  }

  /**
   * Another camera during the call (Flip, or call › Devices): `which` is a device id, or a facing mode
   * on phones. Swapped in with replaceTrack (no renegotiation, the call stays up). While the screen is
   * shared, the new camera waits in my stream and goes out when sharing stops.
   */
  async switchCamera(which: { id: string } | { facing: 'user' | 'environment' }): Promise<MediaStreamTrack | null> {
    if (!this.inCall() || !this.localStream) return null;
    const s = await navigator.mediaDevices.getUserMedia({ video: 'id' in which ? exactly(which.id) : { facingMode: { exact: which.facing } } });
    const t = s.getVideoTracks()[0];
    if (!t) return null;
    if (!this.inCall() || !this.localStream) {
      t.stop();
      return null;
    }
    const old = this.localStream.getVideoTracks()[0];
    t.enabled = old ? old.enabled : true;
    if (!this.shareTrack) await this.replaceVideoTrack(t);
    if (old) {
      this.localStream.removeTrack(old);
      old.stop();
    }
    if (!this.localStream.getVideoTracks().includes(t)) this.localStream.addTrack(t);
    this.emit('localStream', this.localStream);
    return t;
  }

  /** Another microphone during the call (call › Devices): replaceTrack on the sound sender. */
  async switchMic(id: string): Promise<MediaStreamTrack | null> {
    if (!this.inCall() || !this.localStream) return null;
    if (this.mix) throw new Error('Stop sharing your screen first, then change the microphone.');
    const s = await navigator.mediaDevices.getUserMedia({ audio: exactly(id, { echoCancellation: true, noiseSuppression: true, autoGainControl: true }) });
    const t = s.getAudioTracks()[0];
    if (!t) return null;
    if (!this.inCall() || !this.localStream) {
      t.stop();
      return null;
    }
    t.enabled = this.micOn;
    await this.audioSender()?.replaceTrack(t);
    const old = this.localStream.getAudioTracks()[0];
    if (old) {
      this.localStream.removeTrack(old);
      old.stop();
    }
    this.localStream.addTrack(t);
    this.emit('localStream', this.localStream);
    return t;
  }

  /** Screen share and similar: send another video track in place of the camera (null: stop sending video). */
  async replaceVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    const sender = this.pc
      .getTransceivers()
      .find((t) => t.receiver.track.kind === 'video' && t.direction !== 'stopped' && t.currentDirection !== 'stopped')?.sender;
    if (sender) {
      await sender.replaceTrack(track);
      return;
    }
    if (track && this.inCall()) {
      // A voice call: add the video (renegotiated over the locked data channel).
      this.localStream ??= new MediaStream();
      this.localStream.addTrack(track);
      this.pc.addTrack(track, this.localStream);
    }
  }

  private onTrack(e: RTCTrackEvent): void {
    if (!this.inCall()) return; // a late renegotiation after the call ended
    this.remoteStream ??= new MediaStream();
    this.remoteStream.addTrack(e.track);
    e.track.addEventListener('ended', () => this.remoteStream?.removeTrack(e.track));
    e.track.addEventListener('unmute', () => this.checkCallConnected()); // media is really arriving
    this.emit('remoteStream', this.remoteStream);
    this.checkCallConnected();
  }

  private checkCallConnected(): void {
    if (this.call.state === 'connecting' && this.iceUp && (this.remoteStream?.getTracks().some((t) => !t.muted) ?? false)) {
      this.clearCallTimers();
      this.setCall({ state: 'connected', connectedAt: Date.now() });
    }
  }

  private endCall(state: 'ended' | 'failed' | 'missed', failure?: CallFailure, tellThem = false, stopTransceivers = false): void {
    this.clearCallTimers();
    this.iRecord = false;
    if (this.shareTrack) {
      this.shareTrack.stop();
      this.shareTrack = null;
    }
    void this.unmix();
    this.micOn = true;
    this.deviceSoundOn = true;
    if (this.theyShare) {
      this.theyShare = false;
      this.emitScreen();
    }
    if (this.theyRecord) {
      this.theyRecord = false;
      this.emit('recording', false);
    }
    if (tellThem) void this.send({ k: 'hangup', cid: this.callId });
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.emit('localStream', null);
    if (stopTransceivers && this.pc.signalingState !== 'closed') {
      // Stops the media lines; negotiationneeded sends the update over the data channel.
      for (const t of this.pc.getTransceivers()) if (t.currentDirection !== 'stopped' && t.direction !== 'stopped') t.stop();
    }
    this.remoteStream?.getTracks().forEach((t) => this.remoteStream?.removeTrack(t));
    this.remoteStream = null;
    this.emit('remoteStream', null);
    this.setCall({ state, failure });
  }

  /** After the end/failure screen has been closed. */
  resetCall(): void {
    if (!this.inCall()) this.setCall({ state: 'idle', failure: undefined });
  }
}
