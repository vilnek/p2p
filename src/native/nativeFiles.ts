// Photos, videos and files sent as the ORIGINAL (same bytes: no compression, no HEIC -> JPEG, no
// video transcoding), and received files saved to Photos, to Files, or shared / opened.
//
// Works in three places:
//   Android app, iPhone app  the app's "NativeFiles" plugin (native/, NativeFilesPlugin.java /
//                            NativeFilesPlugin.swift): the phone's own photo picker, file picker and
//                            camera; Save to Photos (gallery), Save to Files (folder picker), share sheet.
//   Browser                  <input type=file>, File System Access / the private file area + download,
//                            and navigator.share with files.
//
// Files are never held whole in memory (videos can be several GB):
//   Reading a picked file, read(offset, length):
//     iPhone   fetch with an HTTP Range header from the app's own local server (the file is a copy
//              in the app's temporary folder; the server seeks and returns only that piece).
//     Android  binary messages through the page's "P2PFiles" object (ArrayBuffer, no text copy),
//              read straight from the picked item (no copy), at any position.
//     Else     base64 through a plugin call (slower; always works).
//   Pieces are read in 1 MB blocks with one block read ahead, so a 256 KB chunk rarely waits.
//   Writing a received file: pieces go to a native temporary file at their position (Android:
//   binary messages; iPhone: base64 plugin calls, joined into 1 MB writes). On close() the file
//   moves to the app's received folder; then Save to Photos / Save to Files / Share or open.
//
// Temporary files are removed after a save, a cancel, and when the app starts.

import {
  blobSource,
  canPickSaveFile,
  memorySink,
  MEMORY_SINK_LIMIT,
  opfsSink,
  opfsSupported,
  pickSaveSink,
  removeOpfsFile,
  safeFileName,
  safeMime,
  shareOrDownload,
  type FileSink,
  type FileSource,
  type SinkResult,
} from '../core/sinks';

// ---- types ----------------------------------------------------------------------------------------

export type PickKind = 'media' | 'files' | 'camera';

export interface PickOptions {
  /** Media and files: choose several at once (default true). Camera: always one. */
  multiple?: boolean;
  /** Camera: record a video instead of a photo (Android; the iPhone camera offers both). */
  video?: boolean;
}

/** A picked file: read in pieces, never whole. Call release() when it was sent or cancelled. */
export interface PickedSource extends FileSource {
  /** Frees the phone's temporary copy / open handle. Safe to call twice. */
  release(): Promise<void>;
  /** In a browser: the picked File itself (for a photo / video preview made on this device). */
  blob?: Blob;
}

/** A received file kept by the app (its private "received" folder) until removed. */
export interface NativeFile {
  /** The app's name for it (opaque): pass back to save, share or remove it. */
  ref: string;
  name: string;
  size: number;
  mime: string;
}

/**
 * What close() returns for files received in the app. `where` is 'native' (the app's private
 * received folder); add 'native' to SinkResult['where'] in sinks.ts when wiring.
 */
export interface NativeSinkResult extends Omit<SinkResult, 'where'> {
  where: 'native';
  native: NativeFile;
  /**
   * photosSink / filesSink: where it was saved on close. false: not saved (the person closed the
   * folder picker, or `error` says why); the file stays in the app, so the Save buttons still work.
   */
  saved?: 'photos' | 'files' | false;
  error?: string;
}

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled';

/** An error with a plain message for the screen, and a code for the app. */
export class NativeFilesError extends Error {
  constructor(
    message: string,
    readonly code: 'cancelled' | 'denied' | 'unsupported' | 'missing' | 'failed',
  ) {
    super(message);
    this.name = 'NativeFilesError';
  }
}

// ---- the plugin (native side) -------------------------------------------------------------------

interface PickedInfo {
  handle: number;
  name: string;
  size: number;
  mime: string;
  /** iPhone: the temporary copy's path, for range reads through the local server. */
  path?: string;
}

interface NativeFilesPlugin {
  info(): Promise<{ binary?: boolean; range?: boolean; platform?: string }>;
  pick(o: { kind: PickKind; multiple: boolean; video: boolean }): Promise<{ files: PickedInfo[] }>;
  read(o: { handle: number; offset: number; length: number }): Promise<{ data: string }>;
  release(o: { handle: number }): Promise<void>;
  create(o: { name: string; mime: string; size: number }): Promise<{ handle: number }>;
  write(o: { handle: number; offset: number; data: string }): Promise<void>;
  finish(o: { handle: number; size: number }): Promise<{ ref: string; size: number }>;
  abort(o: { handle: number }): Promise<void>;
  saveToPhotos(o: { ref: string; name: string; mime: string }): Promise<void>;
  saveToFiles(o: { ref: string; name: string; mime: string }): Promise<{ saved: boolean }>;
  share(o: { ref: string; name: string; mime: string }): Promise<void>;
  /** A small JPEG preview of a received photo or video, made by the phone (scaled while decoding). */
  thumb?(o: { ref: string; mime: string; max: number }): Promise<{ data: string }>;
  remove(o: { ref: string }): Promise<void>;
  cleanup(o: { keep?: string[] }): Promise<void>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  isPluginAvailable?: (name: string) => boolean;
  convertFileSrc?: (path: string) => string;
  Plugins?: { NativeFiles?: NativeFilesPlugin };
  registerPlugin?: (name: string) => NativeFilesPlugin;
}

/** The page's binary channel to the Android app (WebViewCompat web message listener). */
interface NativePort {
  postMessage(m: string | ArrayBuffer): void;
  onmessage: ((e: { data: unknown }) => void) | null;
}

const g = () => globalThis as unknown as { Capacitor?: CapacitorGlobal; P2PFiles?: NativePort };

function cap(): CapacitorGlobal | undefined {
  return g().Capacitor;
}

/** True inside the Android / iPhone app when its NativeFiles plugin is there. */
export function isNativeApp(): boolean {
  const c = cap();
  return !!(c?.isNativePlatform?.() && c.isPluginAvailable?.('NativeFiles'));
}

function plugin(): NativeFilesPlugin {
  const c = cap();
  const p = c?.Plugins?.NativeFiles ?? c?.registerPlugin?.('NativeFiles');
  if (!p) throw new NativeFilesError('This needs the P2P Talk app.', 'unsupported');
  return p;
}

let infoP: Promise<{ binary: boolean; range: boolean; platform: string }> | null = null;
function info() {
  infoP ??= plugin()
    .info()
    .then((i) => ({ binary: !!i.binary, range: !!i.range, platform: i.platform ?? cap()?.getPlatform?.() ?? '' }))
    .catch(() => ({ binary: false, range: false, platform: cap()?.getPlatform?.() ?? '' }));
  return infoP;
}

/** Plugin errors -> a plain NativeFilesError. */
function plain(e: unknown, fallback = 'Something went wrong with this file. Please try again.'): NativeFilesError {
  if (e instanceof NativeFilesError) return e;
  const x = e as { code?: string; message?: string } | undefined;
  const code = x?.code;
  if (code === 'cancelled') return new NativeFilesError('Cancelled.', 'cancelled');
  if (code === 'denied') return new NativeFilesError(x?.message || 'P2P Talk is not allowed to do this. You can allow it in Settings.', 'denied');
  if (code === 'unsupported') return new NativeFilesError(x?.message || 'This phone cannot do this.', 'unsupported');
  if (code === 'missing') return new NativeFilesError(x?.message || 'This file is no longer on this phone.', 'missing');
  return new NativeFilesError(x?.message || fallback, 'failed');
}

// ---- base64 -------------------------------------------------------------------------------------

type B64Ctor = { fromBase64?: (s: string) => Uint8Array };
type B64Proto = { toBase64?: () => string };

export function toB64(bytes: Uint8Array): string {
  const fast = (bytes as unknown as B64Proto).toBase64;
  if (typeof fast === 'function') return fast.call(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const fast = (Uint8Array as unknown as B64Ctor).fromBase64;
  if (typeof fast === 'function') return fast(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- binary channel (Android) -------------------------------------------------------------------

/** Write message header: op(1) pad(3) id u32 handle u32 pad u32 offset f64, little-endian. */
export const WRITE_HEADER = 24;
const OP_WRITE = 1;
const PORT_TIMEOUT_MS = 120_000;

export function writeMessage(id: number, handle: number, offset: number, data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(WRITE_HEADER + data.length);
  const v = new DataView(buf);
  v.setUint8(0, OP_WRITE);
  v.setUint32(4, id, true);
  v.setUint32(8, handle, true);
  v.setFloat64(16, offset, true);
  new Uint8Array(buf, WRITE_HEADER).set(data);
  return buf;
}

/** Requests over the page's P2PFiles object; replies matched by id. */
export class BinaryPort {
  private next = 1;
  private waiting = new Map<number, { ok: (v: Uint8Array | null) => void; no: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private port: NativePort) {
    port.onmessage = (e) => this.onMessage(e.data);
  }

  private ask(send: (id: number) => void): Promise<Uint8Array | null> {
    const id = this.next++;
    if (this.next > 0x7fffffff) this.next = 1;
    return new Promise((ok, no) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        no(new NativeFilesError('The phone took too long to read or write the file.', 'failed'));
      }, PORT_TIMEOUT_MS);
      this.waiting.set(id, { ok, no, timer });
      try {
        send(id);
      } catch (e) {
        clearTimeout(timer);
        this.waiting.delete(id);
        no(plain(e));
      }
    });
  }

  private onMessage(d: unknown): void {
    if (d instanceof ArrayBuffer) {
      if (d.byteLength < 4) return;
      const id = new DataView(d).getUint32(0, true);
      this.settle(id, (w) => w.ok(new Uint8Array(d, 4)));
      return;
    }
    if (typeof d !== 'string') return;
    let m: { id?: number; ok?: unknown; err?: string; code?: string };
    try {
      m = JSON.parse(d);
    } catch {
      return;
    }
    if (typeof m.id !== 'number') return;
    this.settle(m.id, (w) => (m.err ? w.no(plain({ code: m.code, message: m.err })) : w.ok(null)));
  }

  private settle(id: number, fn: (w: { ok: (v: Uint8Array | null) => void; no: (e: Error) => void }) => void): void {
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    clearTimeout(w.timer);
    fn(w);
  }

  async read(handle: number, offset: number, length: number): Promise<Uint8Array> {
    const r = await this.ask((id) => this.port.postMessage(JSON.stringify({ op: 'read', id, h: handle, o: offset, n: length })));
    return r ?? new Uint8Array(0);
  }

  async write(handle: number, offset: number, data: Uint8Array): Promise<void> {
    await this.ask((id) => this.port.postMessage(writeMessage(id, handle, offset, data)));
  }
}

let portInst: BinaryPort | null | undefined;
async function binaryPort(): Promise<BinaryPort | null> {
  if (portInst !== undefined) return portInst;
  const p = g().P2PFiles;
  portInst = p && (await info()).binary ? new BinaryPort(p) : null;
  return portInst;
}

// ---- range reads (iPhone: the app's local server) -------------------------------------------------

/** The HTTP Range for [offset, offset + length), within a file of `size` bytes; null if empty. */
export function rangeFor(offset: number, length: number, size: number): { header: string; start: number; end: number; length: number } | null {
  if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length < 0) throw new RangeError('bad range');
  const start = Math.floor(offset);
  const endExcl = Math.min(size, start + Math.floor(length));
  if (endExcl <= start) return null;
  return { header: `bytes=${start}-${endExcl - 1}`, start, end: endExcl - 1, length: endExcl - start };
}

/** Reads [offset, offset+length) from `url` with a Range request. Throws if the server ignores ranges. */
export async function rangeRead(url: string, offset: number, length: number, size: number, f: typeof fetch = fetch): Promise<Uint8Array> {
  const r = rangeFor(offset, length, size);
  if (!r) return new Uint8Array(0);
  const res = await f(url, { headers: { Range: r.header }, cache: 'no-store' });
  if (res.status !== 206) {
    // Some servers answer 200 with the whole file: only acceptable when that is exactly the piece asked for.
    if (res.status === 200 && r.start === 0 && r.length === size) return new Uint8Array(await res.arrayBuffer());
    throw new NativeFilesError('The file could not be read in pieces.', 'failed');
  }
  const out = new Uint8Array(await res.arrayBuffer());
  if (out.length !== r.length) throw new NativeFilesError('The file could not be read in pieces.', 'failed');
  return out;
}

// ---- block reader: 1 MB blocks, one read ahead ------------------------------------------------------

export const READ_BLOCK = 1024 * 1024;

/**
 * Turns "read this block" into read(offset, length) for any offset and length. Keeps the last few
 * blocks and fetches the next one ahead, so sequential 256 KB reads cost about one native call per MB.
 */
export function blockReader(size: number, fetchBlock: (offset: number, length: number) => Promise<Uint8Array>, block = READ_BLOCK, keep = 3) {
  const cache = new Map<number, Promise<Uint8Array>>(); // block index -> bytes (insertion order = age)

  const get = (k: number): Promise<Uint8Array> => {
    let p = cache.get(k);
    if (p) {
      cache.delete(k); // most recent last
      cache.set(k, p);
      return p;
    }
    const off = k * block;
    const len = Math.min(block, size - off);
    p = fetchBlock(off, len).then((b) => {
      if (b.length !== len) throw new NativeFilesError('The file changed or could not be read.', 'failed');
      return b;
    });
    p.catch(() => cache.delete(k)); // a failed block is fetched again next time
    cache.set(k, p);
    while (cache.size > keep) cache.delete(cache.keys().next().value as number);
    return p;
  };

  return async (offset: number, length: number): Promise<Uint8Array> => {
    if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length < 0) throw new RangeError('bad read');
    const end = Math.min(size, offset + length);
    if (end <= offset) return new Uint8Array(0);
    const first = Math.floor(offset / block);
    const last = Math.floor((end - 1) / block);
    const parts: Uint8Array[] = [];
    for (let k = first; k <= last; k++) {
      const b = await get(k);
      const from = k === first ? offset - k * block : 0;
      const to = k === last ? end - k * block : b.length;
      parts.push(b.subarray(from, to));
    }
    // Read ahead: the next block, while this piece is being sent.
    if ((last + 1) * block < size && !cache.has(last + 1)) void get(last + 1).catch(() => undefined);
    if (parts.length === 1) return parts[0].slice();
    const out = new Uint8Array(end - offset);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
}

// ---- picking ------------------------------------------------------------------------------------

/**
 * Opens the phone's picker and returns the chosen files as originals. [] if the person cancels.
 * Call from a tap (the browser's file chooser needs one).
 *   'media'   Photos and videos from the gallery (Android Photo Picker / iPhone Photos)
 *   'files'   Any file, any size (Android Files / iPhone Files)
 *   'camera'  Take a photo (or a video: { video: true } on Android; the iPhone camera offers both)
 */
export function pickOriginals(kind: PickKind, o: PickOptions = {}): Promise<PickedSource[]> {
  if (isNativeApp()) return pickNative(kind, o);
  return pickInBrowser(kind, o);
}

async function pickNative(kind: PickKind, o: PickOptions): Promise<PickedSource[]> {
  const p = plugin();
  let files: PickedInfo[];
  try {
    files = (await p.pick({ kind, multiple: kind !== 'camera' && o.multiple !== false, video: !!o.video })).files ?? [];
  } catch (e) {
    const err = plain(e, 'The file could not be opened.');
    if (err.code === 'cancelled') return [];
    throw err;
  }
  const i = await info();
  const port = await binaryPort();
  return files.map((f) => nativeSource(p, f, i.range, port));
}

function nativeSource(p: NativeFilesPlugin, f: PickedInfo, rangeOk: boolean, port: BinaryPort | null): PickedSource {
  const c = cap();
  const url = rangeOk && f.path && c?.convertFileSrc ? c.convertFileSrc(f.path) : null;
  let useRange = !!url;
  let released = false;
  const viaPlugin = async (off: number, len: number) => fromB64((await p.read({ handle: f.handle, offset: off, length: len })).data);
  const fetchBlock = async (off: number, len: number): Promise<Uint8Array> => {
    if (released) throw new NativeFilesError('This file was closed.', 'failed');
    if (useRange && url) {
      try {
        return await rangeRead(url, off, len, f.size);
      } catch {
        useRange = false; // the local server can't do it: read through the plugin from now on
      }
    }
    try {
      return port ? await port.read(f.handle, off, len) : await viaPlugin(off, len);
    } catch (e) {
      throw plain(e, 'The file could not be read.');
    }
  };
  return {
    name: f.name || 'file',
    size: f.size,
    mime: f.mime || 'application/octet-stream',
    read: blockReader(f.size, fetchBlock),
    async release() {
      if (released) return;
      released = true;
      await p.release({ handle: f.handle }).catch(() => undefined);
    },
  };
}

/** The browser's file chooser. Resolves [] when it is closed without a choice. */
function pickInBrowser(kind: PickKind, o: PickOptions): Promise<PickedSource[]> {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) return Promise.reject(new NativeFilesError('Choosing files is not possible here.', 'unsupported'));
  const input = doc.createElement('input');
  input.type = 'file';
  if (kind === 'media') input.accept = 'image/*,video/*';
  if (kind === 'camera') {
    input.accept = o.video ? 'video/*' : 'image/*';
    input.setAttribute('capture', 'environment');
  }
  input.multiple = kind !== 'camera' && o.multiple !== false;
  input.style.display = 'none';
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const files = Array.from(input.files ?? []);
      input.remove();
      resolve(files.map((f) => ({ ...blobSource(f), mime: f.type || 'application/octet-stream', blob: f, release: async () => undefined })));
    };
    input.addEventListener('change', finish);
    input.addEventListener('cancel', finish);
    // Older browsers have no 'cancel' event: when the page gets the focus back and nothing was chosen.
    const win = globalThis as { addEventListener?: Window['addEventListener']; removeEventListener?: Window['removeEventListener'] };
    const onFocus = () => {
      win.removeEventListener?.('focus', onFocus);
      setTimeout(finish, 1000);
    };
    win.addEventListener?.('focus', onFocus);
    doc.body?.appendChild(input);
    input.click();
  });
}

// ---- saving: which types the gallery takes ----------------------------------------------------------

/** iPhone Photos takes these (others: Save to Files). */
const IOS_PHOTOS = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/gif',
  'image/tiff',
  'image/webp',
  'image/bmp',
  'image/x-adobe-dng',
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/3gpp',
  'video/3gpp2',
]);

/** True when Save to Photos is offered for this type: images and videos, in the app only. */
export function canSaveToPhotos(mime: string): boolean {
  if (!isNativeApp()) return false;
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (cap()?.getPlatform?.() === 'ios') return IOS_PHOTOS.has(m);
  return m.startsWith('image/') || m.startsWith('video/');
}

// ---- sinks --------------------------------------------------------------------------------------

/** A sink made later (or by a promise started now): write/close/abort wait for it. */
export function lazySink(make: Promise<FileSink> | (() => Promise<FileSink>)): FileSink {
  let p: Promise<FileSink> | null = typeof make === 'function' ? null : make;
  p?.catch(() => undefined); // no unhandled rejection before the first write
  const get = () => (p ??= (make as () => Promise<FileSink>)());
  let opened = !!p;
  return {
    async write(offset, data) {
      opened = true;
      return (await get()).write(offset, data);
    },
    async close() {
      opened = true;
      return (await get()).close();
    },
    async abort() {
      if (!opened) return;
      const s = await get().catch(() => null);
      await s?.abort();
    },
  };
}

/** Joins writes that follow each other into one native call of up to `max` bytes. */
export const WRITE_JOIN = 1024 * 1024;

interface NativeWriter {
  open(): Promise<number>;
  write(handle: number, offset: number, data: Uint8Array): Promise<void>;
  finish(handle: number): Promise<{ ref: string; size: number }>;
  abort(handle: number): Promise<void>;
}

/**
 * A sink that writes pieces at their position into a native temporary file. Writes that follow
 * each other are joined into one call of up to `join` bytes; any other offset (a resumed or
 * repeated piece) first sends what is waiting.
 */
export function joinedSink(size: number, w: NativeWriter, done: (r: { ref: string; size: number }) => Promise<SinkResult>, join = WRITE_JOIN): FileSink {
  let handle: Promise<number> | null = null;
  let pend: { off: number; parts: Uint8Array[]; len: number } | null = null;
  let state: 'open' | 'closed' | 'aborted' = 'open';
  let chain: Promise<unknown> = Promise.resolve();
  const h = () => (handle ??= w.open());

  const flush = async () => {
    if (!pend || pend.len === 0) return;
    const { off, parts, len } = pend;
    pend = null;
    let data: Uint8Array;
    if (parts.length === 1) data = parts[0];
    else {
      data = new Uint8Array(len);
      let at = 0;
      for (const x of parts) {
        data.set(x, at);
        at += x.length;
      }
    }
    await w.write(await h(), off, data);
  };

  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = chain.then(fn);
    chain = r.catch(() => undefined);
    return r;
  };

  return {
    write(offset, data) {
      return run(async () => {
        if (state !== 'open') throw new Error('closed');
        if (!Number.isInteger(offset) || offset < 0) throw new RangeError('bad offset');
        if (offset + data.length > size) throw new Error('write past the end of the file');
        if (data.length === 0) return;
        void h().catch(() => undefined); // make the temporary file now (a full phone shows at once)
        if (pend && offset !== pend.off + pend.len) await flush();
        if (!pend) pend = { off: offset, parts: [], len: 0 };
        // Copy: the caller may reuse its buffer.
        pend.parts.push(data.slice());
        pend.len += data.length;
        if (pend.len >= join) await flush();
      });
    },
    close() {
      return run(async () => {
        if (state !== 'open') throw new Error('closed');
        await flush();
        const r = await w.finish(await h());
        state = 'closed';
        return done(r);
      });
    },
    async abort() {
      if (state !== 'open') return;
      state = 'aborted';
      pend = null;
      await chain;
      if (handle) await w.abort(await handle.catch(() => -1)).catch(() => undefined);
    },
  };
}

function nativeWriter(p: NativeFilesPlugin, name: string, size: number, mime: string): NativeWriter {
  let port: BinaryPort | null = null;
  return {
    async open() {
      port = await binaryPort();
      try {
        return (await p.create({ name: safeFileName(name), mime, size })).handle;
      } catch (e) {
        throw plain(e, 'There is no room for this file on the phone.');
      }
    },
    async write(handle, offset, data) {
      try {
        if (port) await port.write(handle, offset, data);
        else await p.write({ handle, offset, data: toB64(data) });
      } catch (e) {
        throw plain(e, 'The file could not be written. Is the phone full?');
      }
    },
    async finish(handle) {
      try {
        return await p.finish({ handle, size });
      } catch (e) {
        throw plain(e, 'The file could not be finished.');
      }
    },
    abort: (handle) => (handle < 0 ? Promise.resolve() : p.abort({ handle })),
  };
}

const nativeResult = (f: NativeFile, saved?: NativeSinkResult['saved'], error?: string): SinkResult =>
  ({ where: 'native', native: f, ...(saved === undefined ? {} : { saved }), ...(error ? { error } : {}) }) as unknown as SinkResult;

/** The native received file inside a sink result, if it is one. */
export function nativeFileOf(r: SinkResult | null | undefined): NativeFile | null {
  const x = r as unknown as NativeSinkResult | null | undefined;
  return x && x.where === 'native' && x.native ? x.native : null;
}

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Where an incoming file goes when nobody has to tap anything (auto-accept, or Accept):
 *   app      the app's private received folder; afterwards Save to Photos / Save to Files / Share or open.
 *   browser  the browser's private file area (OPFS), or memory for files up to 100 MB.
 */
export function receiveSink(name: string, size: number, mime: string): FileSink {
  if (isNativeApp()) {
    const p = plugin();
    return joinedSink(size, nativeWriter(p, name, size, mime), async (r) => nativeResult({ ref: r.ref, name: safeFileName(name), size: r.size, mime }));
  }
  return lazySink(async () => {
    if (await opfsSupported()) return opfsSink(randomId(), name);
    if (size <= MEMORY_SINK_LIMIT) return memorySink(size, mime);
    throw new NativeFilesError('This file is too big for this browser. Use the P2P Talk app.', 'unsupported');
  });
}

/**
 * Receives straight into the gallery: on close() the file goes into Photos (iPhone) or
 * Pictures/P2P Talk and Movies/P2P Talk (Android), and the app's copy is removed. If saving fails
 * (e.g. Photos access refused), close() still succeeds with saved: false and error.
 * Only for types where canSaveToPhotos(mime) is true. In a browser: like filesSink.
 */
export function photosSink(name: string, size: number, mime: string): FileSink {
  if (!isNativeApp()) return filesSink(name, size, mime);
  const p = plugin();
  return joinedSink(size, nativeWriter(p, name, size, mime), async (r) => {
    const f: NativeFile = { ref: r.ref, name: safeFileName(name), size: r.size, mime };
    try {
      await saveToPhotos(nativeResult(f), name, mime);
    } catch (e) {
      return nativeResult(f, false, plain(e).message); // received; saving can be tried again
    }
    await p.remove({ ref: r.ref }).catch(() => undefined);
    return nativeResult(f, 'photos');
  });
}

/**
 * Receives, then on close() asks where to save it (the phone's folder picker) and copies it there.
 * If the person closes the picker, the file stays in the app (result.saved === false).
 * In a browser: the save dialog now (call from a tap) where there is one, else a download at the end.
 */
export function filesSink(name: string, size: number, mime: string): FileSink {
  if (isNativeApp()) {
    const p = plugin();
    return joinedSink(size, nativeWriter(p, name, size, mime), async (r) => {
      const f: NativeFile = { ref: r.ref, name: safeFileName(name), size: r.size, mime };
      let ok = false;
      try {
        ok = await saveToFiles(nativeResult(f), name, mime);
      } catch (e) {
        return nativeResult(f, false, plain(e).message);
      }
      if (ok) await p.remove({ ref: r.ref }).catch(() => undefined);
      return nativeResult(f, ok ? 'files' : false);
    });
  }
  if (canPickSaveFile()) return lazySink(pickSaveSink(name)); // the dialog opens now, inside the tap
  const inner = receiveSink(name, size, mime);
  return {
    write: (o, d) => inner.write(o, d),
    abort: () => inner.abort(),
    async close() {
      const r = await inner.close();
      if (r.file) await downloadBlob(r.file, name);
      return r;
    },
  };
}

// ---- actions on a received file -----------------------------------------------------------------------

/** Save to Photos. Throws NativeFilesError ('denied' when Photos access was refused). */
export async function saveToPhotos(r: SinkResult, name: string, mime: string): Promise<void> {
  const f = nativeFileOf(r);
  if (!f || !isNativeApp()) throw new NativeFilesError('Saving to Photos needs the P2P Talk app.', 'unsupported');
  if (!canSaveToPhotos(mime || f.mime)) throw new NativeFilesError('Photos cannot keep this type of file. Use Save to Files.', 'unsupported');
  try {
    await plugin().saveToPhotos({ ref: f.ref, name: safeFileName(name || f.name), mime: mime || f.mime });
  } catch (e) {
    throw plain(e, 'The file could not be saved to Photos.');
  }
}

/** Save to Files: the folder picker. false when the person closes it without saving. */
export async function saveToFiles(r: SinkResult, name: string, mime: string): Promise<boolean> {
  const f = nativeFileOf(r);
  if (f && isNativeApp()) {
    try {
      return (await plugin().saveToFiles({ ref: f.ref, name: safeFileName(name || f.name), mime: mime || f.mime })).saved;
    } catch (e) {
      const err = plain(e, 'The file could not be saved.');
      if (err.code === 'cancelled') return false;
      throw err;
    }
  }
  if (r.where === 'picked' && !r.file) return true; // already saved where the person picked
  if (!r.file) throw new NativeFilesError('This file is no longer here.', 'missing');
  if (canPickSaveFile()) {
    try {
      const sink = await pickSaveSink(name);
      const reader = blobSource(r.file, name);
      for (let off = 0; off < reader.size; off += READ_BLOCK) await sink.write(off, await reader.read(off, READ_BLOCK));
      await sink.close();
      return true;
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return false;
      throw e;
    }
  }
  await downloadBlob(r.file, name);
  return true;
}

/** Share or open: the phone's share sheet (open in another app, send, save). Browser: share or download. */
export async function shareOrOpen(r: SinkResult, name: string, mime: string): Promise<ShareOutcome> {
  const f = nativeFileOf(r);
  if (f && isNativeApp()) {
    try {
      await plugin().share({ ref: f.ref, name: safeFileName(name || f.name), mime: mime || f.mime });
      return 'shared';
    } catch (e) {
      const err = plain(e, 'The file could not be shared.');
      if (err.code === 'cancelled') return 'cancelled';
      throw err;
    }
  }
  if (!r.file) throw new NativeFilesError('This file is no longer here.', 'missing');
  try {
    return await shareOrDownload(r.file, name);
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return 'cancelled';
    throw e;
  }
}

/** Longest side of a preview made by the phone, in pixels (the web previews use 360). */
export const NATIVE_THUMB_MAX = 360;
/** The largest preview the page accepts from the phone (a 360 px JPEG is about 20-40 KB). */
const NATIVE_THUMB_BYTES = 512 * 1024;
const thumbCache = new Map<string, Promise<Blob | null>>();

/**
 * A preview of a photo or video received in the app, or null (not a photo or video, an older app,
 * or the phone can't read it). The phone makes it scaled down while decoding (iPhone: ImageIO, which
 * also reads HEIC; Android: a sampled decode), so a big photo is never decoded whole; the received
 * file itself is not changed. Remembered per file, so reopening a chat doesn't ask again.
 */
export function receivedThumb(r: SinkResult | null | undefined, mime: string, name: string): Promise<Blob | null> {
  const f = nativeFileOf(r);
  if (!f || !isNativeApp()) return Promise.resolve(null);
  const type = safeMime(mime || f.mime, name || f.name);
  if (!/^(image|video)\//.test(type)) return Promise.resolve(null);
  let p = thumbCache.get(f.ref);
  if (!p) {
    p = (async () => {
      const pl = plugin();
      if (typeof pl.thumb !== 'function') return null;
      try {
        const bytes = fromB64((await pl.thumb({ ref: f.ref, mime: type, max: NATIVE_THUMB_MAX })).data ?? '');
        // Only a JPEG (FF D8 FF), and only a small one: shown through an <img> with type image/jpeg.
        if (bytes.length < 4 || bytes.length > NATIVE_THUMB_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
        return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' });
      } catch {
        return null;
      }
    })();
    const ref = f.ref;
    void p.then((b) => b || thumbCache.delete(ref)); // only a made preview is remembered
    thumbCache.set(ref, p);
    if (thumbCache.size > 200) thumbCache.delete(thumbCache.keys().next().value as string);
  }
  return p;
}

/** Deletes the app's copy of a received file (native received folder, or the browser's private area). */
export async function discardReceived(r: SinkResult): Promise<void> {
  const f = nativeFileOf(r);
  if (f) {
    if (isNativeApp()) await plugin().remove({ ref: f.ref }).catch(() => undefined);
    return;
  }
  if (r.where === 'opfs' && r.opfsName) await removeOpfsFile(r.opfsName);
}

/** Deletes one received file from the app's own received folder (never a copy saved to Photos or Files). */
export async function removeReceivedFile(ref: string): Promise<void> {
  if (!isNativeApp() || !ref) return;
  await plugin().remove({ ref });
}

/**
 * At app start: removes unfinished and temporary files. With `keep` (the refs of received files
 * the chats still show), also removes received files not in it. Does nothing in a browser.
 */
export async function cleanupNativeFiles(keep?: string[]): Promise<void> {
  if (!isNativeApp()) return;
  await plugin()
    .cleanup(keep ? { keep } : {})
    .catch(() => undefined);
}

async function downloadBlob(file: Blob, name: string): Promise<void> {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) return;
  const url = URL.createObjectURL(file);
  const a = doc.createElement('a');
  a.href = url;
  a.download = safeFileName(name);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Tests only: forget the cached plugin facts. */
export function _resetForTests(): void {
  infoP = null;
  portInst = undefined;
  thumbCache.clear();
}
