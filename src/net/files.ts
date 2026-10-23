// Files with no size limit (plan §8.3), between two contacts.
//
//  Control (JSON, on the LOCKED 1:1 chat channel):
//    file-offer   {id, name, size, mime, sha256?, chunk, key, ts, v}  key = per-file AES-256-GCM key (b64url)
//    file-accept  {id, from}      receiver: "send from chunk <from>" (accept, resume, re-send after a bad chunk)
//    file-decline {id}            receiver: no
//    file-stop    {id, why?}      either side: cancel
//    file-pause   {id} / file-resume {id}   either side
//    file-ack     {id, have}      receiver: chunks 0..have-1 are written (flow control + true progress)
//    file-hash    {id, sha256}    sender: whole-file SHA-256, after the last chunk
//    file-done    {id, ok}        receiver: the whole file matched (or not)
//
//  Data (binary, on a DEDICATED data channel `file:<id>`, ordered + reliable):
//    one 256 KB chunk  ->  sealed = nonce(12) || AES-256-GCM(key, nonce, aad, SHA-256(data) || data)
//                          aad    = "p2ptalk-file-v1" || id(9 bytes) || u32be(index)
//    sealed is cut into parts of at most `maxFrame` bytes (WebRTC message size limits), each:
//      0x01 | id (9 bytes) | u32be index | u16be part | u16be parts | bytes
//
// The receiver writes each checked chunk straight to a FileSink (never the whole file in memory),
// keeps a running SHA-256, and on a break tells the sender where to go on from (file-accept.from).

import { sha256 } from '@noble/hashes/sha256';
import { concat, fromB64url, toB64url, toHex, utf8 } from '../core/bytes';
import { isBytes, waitDrained, type Channel, type Frame } from '../core/channel';
import { safeFileName, safeMime, type FileSink, type FileSource, type SinkResult } from '../core/sinks';

export {
  blobSource,
  bytesSource,
  canPickSaveFile,
  fileExtension,
  memorySink,
  opfsSink,
  opfsSupported,
  pickSaveSink,
  removeOpfsFile,
  safeBlob,
  safeFileName,
  safeMime,
  shareOrDownload,
  type FileSink,
  type FileSource,
  type MemorySink,
  type SinkResult,
} from '../core/sinks';

export const FILE_CHUNK = 262_144;
export const AUTO_ACCEPT_BELOW = 100 * 1024 * 1024;
/** Feature name for the peer's hello (the older in-memory "file" feature stays as it is). */
export const FILE_FEATURE = 'files2';
/** Control kinds this module handles (route these from the locked chat channel to FileTransfers). */
export const FILE_KINDS = new Set([
  'file-offer',
  'file-accept',
  'file-decline',
  'file-stop',
  'file-pause',
  'file-resume',
  'file-ack',
  'file-hash',
  'file-done',
]);
/** Label prefix for a dedicated data channel: `file:<id>`. */
export const FILE_CHANNEL_PREFIX = 'file:';

const PART = 0x01;
const HEADER = 18;
const ID_BYTES = 9;
const SEAL_EXTRA = 12 + 32 + 16; // nonce + inner SHA-256 + GCM tag
const MAX_SIZE = 2 ** 50; // 1 PB: "no size limit set by us", but a sane number

export type FileControl =
  | { k: 'file-offer'; v: 1; id: string; name: string; size: number; mime: string; sha256?: string; chunk: number; key: string; ts: number }
  | { k: 'file-accept'; id: string; from: number }
  | { k: 'file-decline'; id: string }
  | { k: 'file-stop'; id: string; why?: string }
  | { k: 'file-pause'; id: string }
  | { k: 'file-resume'; id: string }
  | { k: 'file-ack'; id: string; have: number }
  | { k: 'file-hash'; id: string; sha256: string }
  | { k: 'file-done'; id: string; ok: boolean };

export type TransferState =
  | 'queued' //    out: waiting its turn (8 files go to one contact at a time); "Waiting…"
  | 'offered' //   out: waiting for Accept
  | 'incoming' //  in: Accept / Decline on screen
  | 'active' //    pieces moving
  | 'paused' //    paused by either side
  | 'waiting' //   not connected now; resumes on the next connection
  | 'verifying' // all pieces there, checking the whole-file SHA-256
  | 'done'
  | 'declined'
  | 'cancelled'
  | 'failed';

export interface TransferInfo {
  id: string;
  dir: 'out' | 'in';
  peerId: string;
  name: string;
  size: number;
  mime: string;
  state: TransferState;
  /** Bytes written on the receiver (out: as the receiver confirmed). */
  bytes: number;
  /** Bytes per second over the last few seconds. */
  speed: number;
  /** Seconds left, or null when unknown. */
  eta: number | null;
  pausedByMe: boolean;
  pausedByThem: boolean;
  /** Bad chunks seen (and asked again). */
  corrupt: number;
  /** For cancelled / failed: who or why. */
  error?: string;
  /** Incoming and done: where the file is. */
  result?: SinkResult;
}

export interface FileEvents {
  /** An offer waiting for Accept / Decline (not sent for auto-accepted files). */
  offer(t: TransferInfo): void;
  /** State or progress changed (progress at most every `progressMs`). */
  update(t: TransferInfo): void;
  /** Finished and checked. Incoming: `t.result` says where the file is. */
  done(t: TransferInfo): void;
  /** A chunk failed its check; it is asked again (up to maxRetries). */
  corrupt(t: TransferInfo, index: number): void;
}

export interface FileTransfersOptions {
  /** Offers smaller than this are accepted at once when `autoSink` is given. Default 100 MB. */
  autoAcceptBelow?: number;
  /** Where auto-accepted files go (memory or OPFS; the save picker needs a tap, so not that). */
  autoSink?: (t: TransferInfo) => Promise<FileSink>;
  chunk?: number;
  /** Largest data-channel message. Default 64 KB (safe everywhere); the peer may pass pc.sctp.maxMessageSize. */
  maxFrame?: number;
  /** Chunks in flight beyond the receiver's last ack. Default 32 (8 MB). */
  window?: number;
  /** Receiver acks every N chunks. Default 8 (2 MB). */
  ackEvery?: number;
  /** Back-pressure: wait when the data channel holds more than highWater, until lowWater. */
  highWater?: number;
  lowWater?: number;
  /** No data for this long: ask again from where we are. Default 15 s. */
  stallMs?: number;
  /** Times one chunk may fail its check before the transfer fails. Default 3. */
  maxRetries?: number;
  /** Incoming transfers at once. Default 8. */
  maxIncoming?: number;
  /** Outgoing offers / transfers in flight at once; the rest wait their turn ("queued"). Default 8 (BUG-9). */
  maxOutgoing?: number;
  /** Offers waiting for Accept / Decline at once; more are refused ("busy"). Default 4. */
  maxOffers?: number;
  /** An offer not accepted in this long is dropped (the sender is told). Default 30 min. */
  offerTimeoutMs?: number;
  /** An accepted incoming file with no new piece for this long, while connected, fails (frees its sink). Default 10 min. */
  idleTimeoutMs?: number;
  /** Bytes auto-accepted from this contact per day; past that, the person is asked. Default 1 GB. */
  autoAcceptPerDay?: number;
  /** Space that must stay free on the device after an auto-accepted file. Default 256 MB. */
  autoAcceptReserve?: number;
  /** Free bytes on the device (undefined: unknown). Default: navigator.storage.estimate(). */
  freeSpace?: () => Promise<number | undefined>;
  progressMs?: number;
  now?: () => number;
}

/** Free space as the browser reports it (quota − usage); undefined when it can't tell. */
async function storageFree(): Promise<number | undefined> {
  try {
    const est = await (globalThis.navigator as Navigator | undefined)?.storage?.estimate?.();
    if (!est || typeof est.quota !== 'number' || typeof est.usage !== 'number') return undefined;
    return Math.max(0, est.quota - est.usage);
  } catch {
    return undefined;
  }
}

type Stage = 'queued' | 'offered' | 'incoming' | 'transfer' | 'verifying' | 'done' | 'declined' | 'cancelled' | 'failed';
const FINAL = new Set<Stage>(['done', 'declined', 'cancelled', 'failed']);

interface Transfer {
  id: string;
  idBytes: Uint8Array;
  dir: 'out' | 'in';
  name: string;
  size: number;
  mime: string;
  chunk: number;
  chunks: number;
  keyRaw: Uint8Array;
  key: Promise<CryptoKey>;
  stage: Stage;
  pausedByMe: boolean;
  pausedByThem: boolean;
  bytes: number;
  corrupt: number;
  error?: string;
  samples: [number, number][];
  lastEmit: number;
  lastActivity: number;
  /** When the offer arrived (receiver), and when the last piece was written. */
  offeredAt: number;
  lastProgress: number;
  // sender
  source?: FileSource;
  /** Queued after a "busy" answer: not offered again before this time; and how many times so far. */
  retryAt: number;
  busyCount: number;
  offerSha?: string;
  sentSha?: string;
  shash?: ReturnType<typeof sha256.create>;
  hashedUpTo: number;
  gen: number;
  pump: Promise<void> | null;
  pumpFrom: number;
  pumpAt: number;
  acked: number;
  ackWaiters: (() => void)[];
  data: Channel | null;
  // receiver
  sink?: FileSink;
  next: number;
  recvIndex: number;
  rgen: number;
  rhash?: ReturnType<typeof sha256.create>;
  rsha?: string;
  finalSha?: string;
  assembly: { index: number; parts: number; got: Uint8Array[]; len: number } | null;
  work: Promise<void>;
  retries: Map<number, number>;
  lastAsk: number;
  lastAskFrom: number;
  completing: boolean;
  result?: SinkResult;
}

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const aad = (idBytes: Uint8Array, index: number) => concat(utf8('p2ptalk-file-v1'), idBytes, u32(index));
const digest = async (d: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', d as BufferSource));
const importKey = (raw: Uint8Array) => crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
const isHex64 = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const isIndex = (n: unknown, max: number): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= max;

/** Locks one chunk (exported for tests and other implementations). */
export async function sealChunk(key: CryptoKey, idBytes: Uint8Array, index: number, data: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = concat(await digest(data), data);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(idBytes, index) as BufferSource }, key, pt as BufferSource);
  return concat(iv, new Uint8Array(ct));
}

/** Opens one chunk; throws if it was changed, belongs elsewhere, or its SHA-256 does not match. */
export async function openChunk(key: CryptoKey, idBytes: Uint8Array, index: number, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < SEAL_EXTRA) throw new Error('too short');
  const pt = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.subarray(0, 12) as BufferSource, additionalData: aad(idBytes, index) as BufferSource },
      key,
      sealed.subarray(12) as BufferSource,
    ),
  );
  const data = pt.subarray(32);
  const h = await digest(data);
  for (let i = 0; i < 32; i++) if (h[i] !== pt[i]) throw new Error('chunk SHA-256 mismatch');
  return data;
}

/** Cuts a sealed chunk into data-channel frames. */
export function partFrames(idBytes: Uint8Array, index: number, sealed: Uint8Array, maxFrame: number): Uint8Array[] {
  const room = maxFrame - HEADER;
  const parts = Math.max(1, Math.ceil(sealed.length / room));
  if (parts > 0xffff) throw new Error('frame too small');
  const out: Uint8Array[] = [];
  for (let p = 0; p < parts; p++) {
    const body = sealed.subarray(p * room, (p + 1) * room);
    const f = new Uint8Array(HEADER + body.length);
    const dv = new DataView(f.buffer);
    f[0] = PART;
    f.set(idBytes, 1);
    dv.setUint32(10, index);
    dv.setUint16(14, p);
    dv.setUint16(16, parts);
    f.set(body, HEADER);
    out.push(f);
  }
  return out;
}

function readPart(f: Uint8Array): { id: string; index: number; part: number; parts: number; body: Uint8Array } | null {
  if (f.length < HEADER || f[0] !== PART) return null;
  const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
  return { id: toB64url(f.subarray(1, 1 + ID_BYTES)), index: dv.getUint32(10), part: dv.getUint16(14), parts: dv.getUint16(16), body: f.subarray(HEADER) };
}

const randomId = () => toB64url(crypto.getRandomValues(new Uint8Array(ID_BYTES)));

/**
 * All file transfers with ONE contact. Make one per contact and keep it across reconnects:
 * attach() on every connection (transfers resume), detach() when it drops.
 */
export class FileTransfers {
  private readonly o: Required<Omit<FileTransfersOptions, 'autoSink'>> & Pick<FileTransfersOptions, 'autoSink'>;
  /** Auto-accepted bytes today (M-8 quota). */
  private autoDay = { day: -1, bytes: 0 };
  private readonly transfers = new Map<string, Transfer>();
  private readonly listeners = new Map<keyof FileEvents, Set<(...a: never[]) => void>>();
  private control: Channel | null = null;
  private openData: ((id: string) => Promise<Channel>) | null = null;
  private unsubs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly peerId: string,
    opts: FileTransfersOptions = {},
  ) {
    this.o = {
      autoAcceptBelow: AUTO_ACCEPT_BELOW,
      chunk: FILE_CHUNK,
      maxFrame: 65_536,
      window: 32,
      ackEvery: 8,
      highWater: 4 * 1024 * 1024,
      lowWater: 1024 * 1024,
      stallMs: 15_000,
      maxRetries: 3,
      maxIncoming: 8,
      maxOutgoing: 8,
      maxOffers: 4,
      offerTimeoutMs: 30 * 60_000,
      idleTimeoutMs: 10 * 60_000,
      autoAcceptPerDay: 1024 * 1024 * 1024,
      autoAcceptReserve: 256 * 1024 * 1024,
      freeSpace: storageFree,
      progressMs: 200,
      now: () => Date.now(),
      ...opts,
    };
    if (this.o.maxFrame < 1024) throw new Error('maxFrame too small');
  }

  on<K extends keyof FileEvents>(k: K, fn: FileEvents[K]): () => void {
    const set = this.listeners.get(k) ?? new Set();
    set.add(fn as (...a: never[]) => void);
    this.listeners.set(k, set);
    return () => set.delete(fn as (...a: never[]) => void);
  }

  private emit<K extends keyof FileEvents>(k: K, ...a: Parameters<FileEvents[K]>): void {
    for (const fn of [...(this.listeners.get(k) ?? [])]) (fn as (...x: unknown[]) => void)(...a);
  }

  // ---- connection -----------------------------------------------------------------------------------

  /**
   * A (re)connection with this contact. `control`: the locked chat channel (JSON frames; binary frames
   * on it are also accepted as file data). `openData(id)`: opens a dedicated `file:<id>` data channel
   * (sender side); without it, chunks go on `control` as binary frames.
   */
  attach(control: Channel, openData?: (id: string) => Promise<Channel>): void {
    if (control.peerId !== this.peerId) throw new Error('channel is for another contact');
    this.detach();
    this.control = control;
    this.openData = openData ?? null;
    this.outLimit = Infinity;
    this.unsubs.push(control.onFrame((f) => this.onFrame(f)));
    this.timer = setInterval(() => this.tick(), Math.max(10, Math.floor(this.o.stallMs / 2)));
    const now = this.o.now();
    for (const t of this.transfers.values()) {
      t.lastProgress = now; // the idle limit counts connected time only
      if (t.dir === 'out' && t.stage === 'offered') this.ctl(this.offerFrame(t));
      else if (t.dir === 'out' && (t.stage === 'transfer' || t.stage === 'verifying') && !t.pausedByMe) this.ctl({ k: 'file-resume', id: t.id });
      else if (t.dir === 'in' && (t.stage === 'transfer' || t.stage === 'verifying') && !t.pausedByMe) this.ask(t, true);
      this.update(t, true);
    }
    this.dispatch();
  }

  /** Receiver: a dedicated data channel (`file:<id>`) arrived from this contact. */
  addDataChannel(ch: Channel): void {
    if (ch.peerId !== this.peerId) return;
    this.unsubs.push(ch.onFrame((f) => isBytes(f) && this.onData(f)));
  }

  /** The connection dropped: transfers wait and resume on the next attach(). */
  detach(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const was = this.control;
    this.control = null;
    for (const t of this.transfers.values()) {
      this.stopPump(t);
      t.rgen++;
      t.assembly = null;
      t.recvIndex = t.next;
      if (was) this.update(t, true);
    }
  }

  /** Stops timers and forgets listeners (transfers stay as they are). */
  dispose(): void {
    this.detach();
    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    this.dispatchTimer = null;
    this.listeners.clear();
  }

  get(id: string): TransferInfo | undefined {
    const t = this.transfers.get(id);
    return t && this.info(t);
  }

  list(): TransferInfo[] {
    return [...this.transfers.values()].map((t) => this.info(t));
  }

  // ---- user actions ----------------------------------------------------------------------------------

  /** Offers a file. Resolves with the transfer id at once; follow it with on('update') / on('done'). */
  async send(source: FileSource, opts: { sha256?: string } = {}): Promise<string> {
    if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > MAX_SIZE) throw new Error('bad size');
    const id = randomId();
    const keyRaw = crypto.getRandomValues(new Uint8Array(32));
    const t = this.make({
      id,
      dir: 'out',
      name: safeFileName(source.name),
      size: source.size,
      mime: String(source.mime || 'application/octet-stream').slice(0, 100),
      chunk: this.o.chunk,
      keyRaw,
      stage: 'queued',
    });
    t.source = source;
    t.offerSha = isHex64(opts.sha256) ? opts.sha256 : undefined;
    t.shash = sha256.create();
    this.transfers.set(id, t);
    this.update(t, true);
    this.dispatch();
    return id;
  }

  private dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  /** In flight at once on this connection (lowered when the receiver says "busy"). */
  private outLimit = Infinity;

  private inFlight(): number {
    let n = 0;
    for (const t of this.transfers.values()) if (t.dir === 'out' && (t.stage === 'offered' || t.stage === 'transfer' || t.stage === 'verifying')) n++;
    return n;
  }

  /**
   * Offers queued files while fewer than maxOutgoing are in flight to this contact, in the order they
   * were picked (BUG-9: the receiver takes 8 at a time and answers "busy" past that).
   */
  private dispatch(): void {
    if (!this.control) return;
    const now = this.o.now();
    const out = [...this.transfers.values()].filter((t) => t.dir === 'out');
    let inFlight = this.inFlight();
    const limit = Math.min(this.o.maxOutgoing, this.outLimit);
    let nextRetry = Infinity;
    for (const t of out) {
      if (inFlight >= limit) break;
      if (t.stage !== 'queued') continue;
      if (t.retryAt > now) {
        nextRetry = Math.min(nextRetry, t.retryAt);
        continue;
      }
      t.stage = 'offered';
      inFlight++;
      this.ctl(this.offerFrame(t));
      this.update(t, true);
    }
    if (nextRetry < Infinity && !this.dispatchTimer) {
      this.dispatchTimer = setTimeout(() => {
        this.dispatchTimer = null;
        this.dispatch();
      }, Math.max(10, nextRetry - now));
    }
  }

  /** Receiver: Accept, writing into `sink`. */
  async accept(id: string, sink: FileSink): Promise<void> {
    const t = this.transfers.get(id);
    if (!t || t.dir !== 'in' || t.stage !== 'incoming') throw new Error('nothing to accept');
    t.sink = sink;
    t.stage = 'transfer';
    t.rhash = sha256.create();
    t.lastActivity = this.o.now();
    t.lastProgress = t.lastActivity;
    this.ask(t, true);
    this.update(t, true);
    if (t.chunks === 0) this.queue(t, () => this.checkComplete(t));
  }

  decline(id: string): void {
    const t = this.transfers.get(id);
    if (!t || t.dir !== 'in' || t.stage !== 'incoming') return;
    t.stage = 'declined';
    this.ctl({ k: 'file-decline', id });
    this.update(t, true);
  }

  /** Either side: stop for good. */
  cancel(id: string): void {
    const t = this.transfers.get(id);
    if (!t || FINAL.has(t.stage)) return;
    this.ctl({ k: 'file-stop', id });
    this.finish(t, 'cancelled', 'you cancelled');
  }

  pause(id: string): void {
    const t = this.transfers.get(id);
    if (!t || FINAL.has(t.stage) || t.stage === 'incoming' || t.stage === 'queued' || t.pausedByMe) return;
    t.pausedByMe = true;
    this.ctl({ k: 'file-pause', id });
    this.stopPump(t);
    this.update(t, true);
  }

  resume(id: string): void {
    const t = this.transfers.get(id);
    if (!t || !t.pausedByMe || FINAL.has(t.stage)) return;
    t.pausedByMe = false;
    this.ctl({ k: 'file-resume', id });
    if (t.dir === 'in' && !t.pausedByThem && t.stage !== 'offered') this.ask(t, true);
    this.update(t, true);
  }

  // ---- frames -----------------------------------------------------------------------------------------

  /** Every frame from this contact's locked chat channel (JSON: control; binary: data fallback). */
  onFrame(f: Frame): void {
    if (isBytes(f)) return this.onData(f);
    const w = f as FileControl;
    if (!w || typeof w.k !== 'string' || !FILE_KINDS.has(w.k) || typeof w.id !== 'string') return;
    if (w.k === 'file-offer') return void this.onOffer(w);
    const t = this.transfers.get(w.id);
    if (!t) {
      if (w.k === 'file-accept' || w.k === 'file-resume') this.ctl({ k: 'file-stop', id: w.id, why: 'unknown' });
      return;
    }
    t.lastActivity = this.o.now();
    if (t.dir === 'out') this.onSenderControl(t, w);
    else this.onReceiverControl(t, w);
  }

  private onSenderControl(t: Transfer, w: FileControl): void {
    switch (w.k) {
      case 'file-accept': {
        if (t.stage === 'cancelled' || t.stage === 'failed') return this.ctl({ k: 'file-stop', id: t.id });
        if (FINAL.has(t.stage) || !isIndex(w.from, t.chunks)) return;
        t.stage = 'transfer'; // also from 'verifying': a piece (or the hash) must go again
        t.pausedByThem = false;
        t.acked = Math.max(t.acked, w.from);
        if (t.pausedByMe) return this.update(t, true);
        // The same "from" while that pump has not sent anything yet (two resumes crossing): keep it.
        if (t.pump && t.pumpFrom === w.from && t.pumpAt === w.from) return;
        void this.startPump(t, w.from);
        return this.update(t, true);
      }
      case 'file-ack':
        if (isIndex(w.have, t.chunks) && w.have > t.acked) {
          t.acked = w.have;
          t.bytes = Math.min(t.size, w.have * t.chunk);
          this.sample(t);
          this.wake(t);
          this.update(t);
        }
        return;
      case 'file-decline':
        if (t.stage === 'offered') this.finish(t, 'declined', 'they declined');
        return;
      case 'file-stop':
        if (w.why === 'busy' && t.stage === 'offered') {
          // They take a few at a time: wait a little and offer it again (never "cancelled").
          // An older or busier receiver takes fewer: send no more at once than it has now.
          t.stage = 'queued';
          t.busyCount++;
          this.outLimit = Math.max(1, this.inFlight());
          t.retryAt = this.o.now() + 1000 * Math.min(10, t.busyCount);
          this.update(t, true);
          return this.dispatch();
        }
        return this.finish(t, 'cancelled', w.why === 'unknown' ? 'they no longer have this file' : 'they cancelled');
      case 'file-pause':
        if (FINAL.has(t.stage)) return;
        t.pausedByThem = true;
        this.stopPump(t);
        return this.update(t, true);
      case 'file-resume':
        t.pausedByThem = false; // the file-accept that follows restarts the pump
        return this.update(t, true);
      case 'file-done':
        if (FINAL.has(t.stage)) return;
        if (w.ok === true) {
          t.bytes = t.size;
          this.finish(t, 'done');
        } else this.finish(t, 'failed', 'the file did not match on their side');
        return;
    }
  }

  private onReceiverControl(t: Transfer, w: FileControl): void {
    switch (w.k) {
      case 'file-stop':
        return this.finish(t, 'cancelled', 'they cancelled');
      case 'file-pause':
        if (FINAL.has(t.stage)) return;
        t.pausedByThem = true;
        return this.update(t, true);
      case 'file-resume':
        if (t.stage === 'done') return this.ctl({ k: 'file-done', id: t.id, ok: true });
        if (t.stage === 'cancelled' || t.stage === 'failed') return this.ctl({ k: 'file-stop', id: t.id });
        if (t.stage === 'declined') return this.ctl({ k: 'file-decline', id: t.id });
        t.pausedByThem = false;
        if (!t.pausedByMe && (t.stage === 'transfer' || t.stage === 'verifying')) this.ask(t, true);
        return this.update(t, true);
      case 'file-hash':
        if (!isHex64(w.sha256) || FINAL.has(t.stage)) return;
        t.finalSha = w.sha256;
        this.queue(t, () => this.checkComplete(t));
        return;
    }
  }

  private async onOffer(w: Extract<FileControl, { k: 'file-offer' }>): Promise<void> {
    const known = this.transfers.get(w.id);
    if (known) {
      if (known.dir !== 'in') return;
      // A repeated offer (after a reconnect): answer with where we are.
      if (known.stage === 'done') this.ctl({ k: 'file-done', id: w.id, ok: true });
      else if (known.stage === 'declined') this.ctl({ k: 'file-decline', id: w.id });
      else if (known.stage === 'cancelled' || known.stage === 'failed') this.ctl({ k: 'file-stop', id: w.id });
      else if (known.stage !== 'incoming' && !known.pausedByMe) this.ask(known, true);
      return;
    }
    let idBytes: Uint8Array, keyRaw: Uint8Array;
    try {
      idBytes = fromB64url(w.id);
      keyRaw = fromB64url(w.key);
    } catch {
      return;
    }
    const ok =
      idBytes.length === ID_BYTES &&
      toB64url(idBytes) === w.id &&
      keyRaw.length === 32 &&
      Number.isSafeInteger(w.size) &&
      w.size >= 0 &&
      w.size <= MAX_SIZE &&
      Number.isSafeInteger(w.chunk) &&
      w.chunk >= 16_384 &&
      w.chunk <= 1_048_576 &&
      (w.sha256 === undefined || isHex64(w.sha256));
    if (!ok) return;
    this.expireOffers();
    const open = [...this.transfers.values()].filter((t) => t.dir === 'in' && !FINAL.has(t.stage));
    if (open.length >= this.o.maxIncoming || open.filter((t) => t.stage === 'incoming').length >= this.o.maxOffers)
      return this.ctl({ k: 'file-stop', id: w.id, why: 'busy' });
    const t = this.make({
      id: w.id,
      dir: 'in',
      name: safeFileName(w.name),
      size: w.size,
      // Never an active type such as text/html or image/svg+xml (M-3): see safeMime.
      mime: safeMime(typeof w.mime === 'string' ? w.mime.slice(0, 100) : '', w.name),
      chunk: w.chunk,
      keyRaw,
      stage: 'incoming',
    });
    t.offerSha = w.sha256;
    this.transfers.set(t.id, t);
    if (t.size < this.o.autoAcceptBelow && this.o.autoSink && (await this.mayAutoAccept(t.size)) && t.stage === 'incoming') {
      try {
        return await this.accept(t.id, await this.o.autoSink(this.info(t)));
      } catch {
        /* fall through: ask the person */
      }
    }
    this.emit('offer', this.info(t));
    this.update(t, true);
  }

  /** Auto-accept only within today's quota for this contact and with room left on the device (M-8). */
  private async mayAutoAccept(size: number): Promise<boolean> {
    const day = Math.floor(this.o.now() / 86_400_000);
    if (this.autoDay.day !== day) this.autoDay = { day, bytes: 0 };
    if (this.autoDay.bytes + size > this.o.autoAcceptPerDay) return false;
    const counted = this.autoDay;
    counted.bytes += size; // counted before the wait, so offers arriving together can't all pass
    const free = await this.o.freeSpace().catch(() => undefined);
    if (free === undefined || free >= size + this.o.autoAcceptReserve) return true;
    counted.bytes -= size;
    return false;
  }

  /** Offers left waiting too long are dropped, and the sender is told (M-8). */
  private expireOffers(): void {
    const now = this.o.now();
    for (const t of this.transfers.values()) {
      if (t.dir !== 'in' || t.stage !== 'incoming' || now - t.offeredAt <= this.o.offerTimeoutMs) continue;
      this.ctl({ k: 'file-stop', id: t.id, why: 'expired' });
      this.finish(t, 'cancelled', 'not accepted in time');
    }
  }

  // ---- receiving data -----------------------------------------------------------------------------

  private onData(f: Uint8Array): void {
    const p = readPart(f);
    if (!p) return;
    const t = this.transfers.get(p.id);
    if (!t || t.dir !== 'in' || t.stage !== 'transfer' || p.index >= t.chunks) return;
    t.lastActivity = this.o.now();
    if (p.index < t.recvIndex) return; // a piece we already have (a resend)
    if (p.index > t.recvIndex) return this.askGap(t); // a gap: something went missing
    if (p.parts === 0) return; // memory is bounded by the length check below
    if (p.part === 0) t.assembly = { index: p.index, parts: p.parts, got: [], len: 0 };
    const a = t.assembly;
    if (!a || a.index !== p.index || a.parts !== p.parts || a.got.length !== p.part) {
      t.assembly = null;
      return this.askGap(t);
    }
    a.got.push(p.body.slice());
    a.len += p.body.length;
    if (a.len > t.chunk + SEAL_EXTRA) {
      t.assembly = null;
      return this.askGap(t);
    }
    if (a.got.length < a.parts) return;
    t.assembly = null;
    t.recvIndex = p.index + 1;
    const sealed = concat(...a.got);
    const rgen = t.rgen;
    this.queue(t, () => this.writeChunk(t, p.index, sealed, rgen));
  }

  /** Receiver work runs one at a time per transfer (writes in order). */
  private queue(t: Transfer, task: () => Promise<void>): void {
    t.work = t.work.then(task).catch((e) => {
      console.warn('P2P Talk: file', e);
      if (!FINAL.has(t.stage)) {
        this.ctl({ k: 'file-stop', id: t.id, why: 'error' });
        this.finish(t, 'failed', 'could not save the file');
      }
    });
  }

  private async writeChunk(t: Transfer, index: number, sealed: Uint8Array, rgen: number): Promise<void> {
    if (rgen !== t.rgen || t.stage !== 'transfer' || index !== t.next) return;
    let data: Uint8Array;
    try {
      data = await openChunk(await t.key, t.idBytes, index, sealed);
      const want = Math.min(t.chunk, t.size - index * t.chunk);
      if (data.length !== want) throw new Error('wrong length');
    } catch {
      return this.onCorrupt(t, index);
    }
    if (rgen !== t.rgen || t.stage !== 'transfer') return;
    await t.sink!.write(index * t.chunk, data);
    t.rhash!.update(data);
    t.next = index + 1;
    t.lastProgress = this.o.now();
    t.bytes = Math.min(t.size, t.next * t.chunk);
    t.retries.delete(index);
    this.sample(t);
    if (t.next % this.o.ackEvery === 0 || t.next === t.chunks) this.ctl({ k: 'file-ack', id: t.id, have: t.next });
    this.update(t);
    if (t.next === t.chunks) await this.checkComplete(t);
  }

  private onCorrupt(t: Transfer, index: number): void {
    t.corrupt++;
    this.emit('corrupt', this.info(t), index);
    const n = (t.retries.get(index) ?? 0) + 1;
    t.retries.set(index, n);
    if (n > this.o.maxRetries) {
      this.ctl({ k: 'file-stop', id: t.id, why: 'corrupt' });
      return this.finish(t, 'failed', 'pieces kept arriving damaged');
    }
    // Throw away anything queued after it and ask again from this chunk.
    t.rgen++;
    t.assembly = null;
    t.recvIndex = t.next;
    this.ask(t, true);
  }

  private async checkComplete(t: Transfer): Promise<void> {
    if (t.completing || FINAL.has(t.stage) || t.next < t.chunks || !t.sink) return;
    const expected = t.finalSha ?? t.offerSha;
    if (!expected) {
      if (t.stage !== 'verifying') {
        t.stage = 'verifying';
        this.update(t, true);
      }
      return;
    }
    t.completing = true;
    t.rsha ??= toHex(t.rhash!.digest());
    const okHash = t.rsha === expected && (!t.offerSha || !t.finalSha || t.offerSha === t.finalSha);
    if (!okHash) {
      this.ctl({ k: 'file-done', id: t.id, ok: false });
      return this.finish(t, 'failed', 'the file did not match (SHA-256)');
    }
    t.stage = 'verifying';
    t.result = await t.sink.close();
    t.sink = undefined; // closed: finish() must not abort it
    this.ctl({ k: 'file-done', id: t.id, ok: true });
    this.finish(t, 'done');
  }

  /** Receiver: "send from chunk <next>". Not more often than every stallMs unless forced. */
  private ask(t: Transfer, force = false): void {
    if (!this.control || t.pausedByMe) return;
    const now = this.o.now();
    if (!force && t.lastAskFrom === t.next && now - t.lastAsk < this.o.stallMs) return;
    t.lastAsk = now;
    t.lastAskFrom = t.next;
    t.lastActivity = now;
    t.rgen++;
    t.assembly = null;
    t.recvIndex = t.next;
    this.ctl({ k: 'file-accept', id: t.id, from: t.next });
  }

  /** Receiver: a piece went missing on the wire; ask again from the chunk being received (queued chunks stay). */
  private askGap(t: Transfer): void {
    if (!this.control || t.pausedByMe) return;
    const now = this.o.now();
    t.assembly = null;
    if (t.lastAskFrom === t.recvIndex && now - t.lastAsk < this.o.stallMs) return;
    t.lastAsk = now;
    t.lastAskFrom = t.recvIndex;
    this.ctl({ k: 'file-accept', id: t.id, from: t.recvIndex });
  }

  // ---- sending data ---------------------------------------------------------------------------------

  private async startPump(t: Transfer, from: number): Promise<void> {
    const gen = ++t.gen;
    this.wake(t);
    const old = t.pump;
    t.pumpFrom = from;
    t.pumpAt = from;
    const run = (async () => {
      await old?.catch(() => undefined);
      if (gen === t.gen) await this.runPump(t, gen, from);
    })();
    t.pump = run;
    try {
      await run;
    } finally {
      if (t.pump === run) t.pump = null;
    }
  }

  private stopPump(t: Transfer): void {
    t.gen++;
    this.wake(t);
    t.data?.close?.();
    t.data = null;
  }

  private wake(t: Transfer): void {
    const w = t.ackWaiters;
    t.ackWaiters = [];
    w.forEach((f) => f());
  }

  private async runPump(t: Transfer, gen: number, from: number): Promise<void> {
    const alive = () => gen === t.gen && !!this.control && t.stage === 'transfer' && !t.pausedByMe && !t.pausedByThem;
    try {
      if (!alive()) return;
      if (!t.data) t.data = this.openData ? await this.openData(t.id) : this.control;
      const ch = t.data!;
      const key = await t.key;
      for (let i = from; i < t.chunks; i++) {
        while (alive() && i >= t.acked + this.o.window) await new Promise<void>((r) => t.ackWaiters.push(r));
        if (!alive()) return;
        if (ch.bufferedAmount && ch.bufferedAmount() > this.o.highWater) await waitDrained(ch, this.o.lowWater);
        if (!alive()) return;
        const off = i * t.chunk;
        const len = Math.min(t.chunk, t.size - off);
        const data = await t.source!.read(off, len);
        if (data.length !== len) throw new FileReadError();
        if (i === t.hashedUpTo) {
          t.shash!.update(data);
          t.hashedUpTo++;
        }
        const frames = partFrames(t.idBytes, i, await sealChunk(key, t.idBytes, i, data), this.o.maxFrame);
        for (const f of frames) {
          if (!alive()) return;
          await ch.send(f);
        }
        t.pumpAt = i + 1;
        t.lastActivity = this.o.now();
      }
      if (!alive()) return;
      if (t.hashedUpTo === t.chunks) t.sentSha ??= toHex(t.shash!.digest());
      if (!t.sentSha) return; // cannot happen: chunks are always read in order the first time
      t.stage = 'verifying';
      this.ctl({ k: 'file-hash', id: t.id, sha256: t.sentSha });
      this.update(t, true);
    } catch (e) {
      if (e instanceof FileReadError || (e as Error)?.name === 'NotReadableError' || (e as Error)?.name === 'NotFoundError') {
        this.ctl({ k: 'file-stop', id: t.id, why: 'error' });
        this.finish(t, 'failed', 'the file could not be read (moved or changed?)');
        return;
      }
      // The data channel broke: the next attach / stall check resumes from the receiver's position.
      if (gen === t.gen) {
        t.data?.close?.();
        t.data = null;
      }
    }
  }

  // ---- shared -----------------------------------------------------------------------------------

  private tick(): void {
    const now = this.o.now();
    this.expireOffers();
    for (const t of this.transfers.values()) {
      if (t.dir === 'in' && t.stage === 'transfer') {
        if (t.pausedByMe || t.pausedByThem) t.lastProgress = now;
        else if (now - t.lastProgress > this.o.idleTimeoutMs) {
          // Accepted, connected, and nothing arrives: free the sink (memory or disk) instead of holding it.
          this.ctl({ k: 'file-stop', id: t.id, why: 'idle' });
          this.finish(t, 'failed', 'nothing arrived for too long');
          continue;
        }
      }
      if (t.pausedByMe || t.pausedByThem || now - t.lastActivity < this.o.stallMs) continue;
      if (t.dir === 'in' && t.stage === 'transfer') this.ask(t);
      else if (t.dir === 'in' && t.stage === 'verifying' && !t.finalSha && !t.offerSha) this.ask(t);
      else if (t.dir === 'out' && (t.stage === 'verifying' || (t.stage === 'transfer' && !t.pump))) {
        t.lastActivity = now;
        this.ctl({ k: 'file-resume', id: t.id });
      }
    }
  }

  private finish(t: Transfer, stage: 'done' | 'declined' | 'cancelled' | 'failed', error?: string): void {
    if (FINAL.has(t.stage)) return;
    t.stage = stage;
    t.error = error;
    this.stopPump(t);
    t.rgen++;
    t.assembly = null;
    if (stage !== 'done' && t.sink) {
      const s = t.sink;
      t.sink = undefined;
      void s.abort().catch(() => undefined);
    }
    t.source = undefined;
    t.keyRaw.fill(0);
    this.update(t, true);
    if (stage === 'done') this.emit('done', this.info(t));
    if (t.dir === 'out') this.dispatch(); // a place is free for the next queued file
  }

  private ctl(w: FileControl): void {
    void this.control?.send(w).catch(() => undefined);
  }

  private offerFrame(t: Transfer): FileControl {
    const o: FileControl = {
      k: 'file-offer',
      v: 1,
      id: t.id,
      name: t.name,
      size: t.size,
      mime: t.mime,
      chunk: t.chunk,
      key: toB64url(t.keyRaw),
      ts: this.o.now(),
    };
    if (t.offerSha) o.sha256 = t.offerSha;
    return o;
  }

  private make(p: Pick<Transfer, 'id' | 'dir' | 'name' | 'size' | 'mime' | 'chunk' | 'keyRaw' | 'stage'>): Transfer {
    const now = this.o.now();
    return {
      ...p,
      idBytes: fromB64url(p.id),
      chunks: Math.ceil(p.size / p.chunk),
      key: importKey(p.keyRaw),
      pausedByMe: false,
      pausedByThem: false,
      bytes: 0,
      corrupt: 0,
      samples: [],
      lastEmit: 0,
      lastActivity: now,
      offeredAt: now,
      lastProgress: now,
      hashedUpTo: 0,
      gen: 0,
      pump: null,
      pumpFrom: -1,
      pumpAt: -1,
      acked: 0,
      ackWaiters: [],
      data: null,
      next: 0,
      recvIndex: 0,
      rgen: 0,
      assembly: null,
      work: Promise.resolve(),
      retries: new Map(),
      lastAsk: 0,
      lastAskFrom: -1,
      completing: false,
      retryAt: 0,
      busyCount: 0,
    };
  }

  private sample(t: Transfer): void {
    const now = this.o.now();
    t.samples.push([now, t.bytes]);
    while (t.samples.length > 2 && now - t.samples[0][0] > 5000) t.samples.shift();
  }

  private info(t: Transfer): TransferInfo {
    let state: TransferState;
    if (FINAL.has(t.stage) || t.stage === 'queued' || t.stage === 'offered' || t.stage === 'incoming') state = t.stage as TransferState;
    else if (t.pausedByMe || t.pausedByThem) state = 'paused';
    else if (!this.control) state = 'waiting';
    else state = t.stage === 'verifying' ? 'verifying' : 'active';
    let speed = 0;
    const s = t.samples;
    if (s.length >= 2 && state === 'active') {
      const [t0, b0] = s[0];
      const [t1, b1] = s[s.length - 1];
      if (t1 > t0) speed = ((b1 - b0) * 1000) / (t1 - t0);
    }
    const eta = speed > 0 ? Math.ceil((t.size - t.bytes) / speed) : null;
    const i: TransferInfo = {
      id: t.id,
      dir: t.dir,
      peerId: this.peerId,
      name: t.name,
      size: t.size,
      mime: t.mime,
      state,
      bytes: t.bytes,
      speed,
      eta,
      pausedByMe: t.pausedByMe,
      pausedByThem: t.pausedByThem,
      corrupt: t.corrupt,
    };
    if (t.error) i.error = t.error;
    if (t.result) i.result = t.result;
    return i;
  }

  private update(t: Transfer, force = false): void {
    const now = this.o.now();
    if (!force && now - t.lastEmit < this.o.progressMs) return;
    t.lastEmit = now;
    this.emit('update', this.info(t));
  }
}

class FileReadError extends Error {
  constructor() {
    super('file could not be read');
  }
}
