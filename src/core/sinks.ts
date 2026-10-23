// Where an incoming file goes, piece by piece. A received file is never held whole in memory
// (except by the memory sink, which is for tests and small files only).
//
//   pickSaveSink()  Chrome / Edge desktop, Android Chrome: File System Access, saved where the user picks.
//                   Must be called from a tap (showSaveFilePicker needs a user gesture), e.g. "Accept".
//   opfsSink()      Safari / iPhone PWA (and any browser with OPFS writable streams): the app's private
//                   file area; afterwards "Save / Share" (shareOrDownload) and removeOpfsFile().
//   memorySink()    Tests, and small files (default limit 100 MB).
//
// Plan §8.3. Writes are positional (offset = chunk index × chunk size), so a resumed transfer that
// sends a piece again simply writes it again in the same place.

export interface SinkResult {
  /** The finished file. File System Access: undefined (it is already saved where the user picked). */
  file?: Blob;
  /** Where it is: 'picked' (user's folder), 'opfs' (app's private file area) or 'memory'. */
  where: 'picked' | 'opfs' | 'memory' | 'native';
  /** OPFS: the file name inside the app's private folder (for removeOpfsFile). */
  opfsName?: string;
}

export interface FileSink {
  /** Writes `data` at byte `offset`. Called in order, one at a time. */
  write(offset: number, data: Uint8Array): Promise<void>;
  /** All bytes written and checked: finish the file. */
  close(): Promise<SinkResult>;
  /** Cancelled or failed: throw away what was written. */
  abort(): Promise<void>;
}

/** A file to send: read in pieces, never whole. */
export interface FileSource {
  name: string;
  size: number;
  mime: string;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** A Blob / File as a FileSource (Blob.slice reads only the piece asked for). */
export function blobSource(blob: Blob, name = (blob as File).name ?? 'file'): FileSource {
  return {
    name,
    size: blob.size,
    mime: blob.type,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}

/** Bytes in memory as a FileSource (tests, small generated files). */
export function bytesSource(bytes: Uint8Array, name = 'file.bin', mime = 'application/octet-stream'): FileSource {
  return { name, size: bytes.length, mime, read: async (o, n) => bytes.slice(o, o + n) };
}

// ---- (c) memory -------------------------------------------------------------------------------------

export const MEMORY_SINK_LIMIT = 100 * 1024 * 1024;

export interface MemorySink extends FileSink {
  /** The bytes written so far (tests). */
  bytes(): Uint8Array;
}

/** Keeps the file in memory. For tests and small files only: refuses to grow past `limit`. */
export function memorySink(size: number, mime = 'application/octet-stream', limit = MEMORY_SINK_LIMIT): MemorySink {
  mime = safeMime(mime); // a received file never gets an active type (M-3)
  if (size > limit) throw new Error('This file is too big to keep in memory.');
  let buf: Uint8Array | null = new Uint8Array(size);
  return {
    async write(offset, data) {
      if (!buf) throw new Error('closed');
      if (offset + data.length > buf.length) throw new Error('write past the end of the file');
      buf.set(data, offset);
    },
    async close() {
      if (!buf) throw new Error('closed');
      return { file: new Blob([buf as Uint8Array<ArrayBuffer>], { type: mime }), where: 'memory' };
    },
    async abort() {
      buf = null;
    },
    bytes: () => buf ?? new Uint8Array(0),
  };
}

// ---- shared: a FileSystemWritableFileStream sink --------------------------------------------------------

interface Writable {
  write(d: { type: 'write'; position: number; data: BufferSource }): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * Safari's WebKit writes a typed array's whole buffer and ignores its offset, so a view into a bigger
 * buffer (a decrypted chunk after its 32-byte hash) is copied to a buffer of its own first.
 */
export function ownBytes(data: Uint8Array): Uint8Array {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
}

function writableSink(w: Writable, done: () => Promise<SinkResult>, cleanup: () => Promise<void> = async () => {}): FileSink {
  let open = true;
  return {
    async write(offset, data) {
      if (!open) throw new Error('closed');
      await w.write({ type: 'write', position: offset, data: ownBytes(data) as Uint8Array<ArrayBuffer> });
    },
    async close() {
      open = false;
      await w.close();
      return done();
    },
    async abort() {
      if (!open) return;
      open = false;
      try {
        await w.abort();
      } catch {
        /* already gone */
      }
      await cleanup();
    },
  };
}

/**
 * A safe file name: no folders, no control characters, no invisible format / direction characters
 * (U+202E would show "holiday<RLO>gpj.exe" as "holidayexe.jpg", L-4), no trailing dots or spaces, no
 * Windows device names, at most 200 characters, and the real extension kept when it is shortened.
 */
export function safeFileName(name: string): string {
  let s = String(name)
    .normalize('NFC')
    // Format characters (\p{Cf}: bidi marks and overrides U+200E/F, U+202A–E, U+2066–9, U+061C, zero
    // width space, BOM…) except the zero width joiner used inside emoji; line / paragraph separators.
    .replace(/(?!\u200d)[\p{Cf}\u2028\u2029]/gu, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\p{Cc}/\\:*?"<>|]/gu, '_')
    .replace(/^\.+/, '_')
    .trim()
    .replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i.test(s)) s = `_${s}`;
  if (s.length > 200) {
    const ext = /\.[^.]{1,16}$/.exec(s)?.[0] ?? '';
    s = s.slice(0, 200 - ext.length) + ext;
  }
  return s || 'file';
}

/** The extension the system will use to open the file (after safeFileName), lower case, or ''. */
export const fileExtension = (name: string): string => /\.([^.]{1,16})$/.exec(safeFileName(name))?.[1].toLowerCase() ?? '';

/**
 * Types a received file may keep: only ones a browser shows without running anything (images, audio,
 * video, PDF). Everything else, above all text/html, image/svg+xml, XML and scripts, becomes
 * application/octet-stream, so a blob: URL of it never renders as a page in this origin (M-3).
 */
const PREVIEW_TYPES = /^(image\/(png|jpeg|gif|webp|avif|bmp|heic|heif)|audio\/(mpeg|mp4|aac|ogg|opus|wav|webm|flac|x-m4a)|video\/(mp4|webm|ogg|quicktime|x-m4v)|application\/pdf)$/;

/** A safe type for a received file. `name` is only used when no type is given (by its extension). */
export function safeMime(mime: string | undefined | null, name?: string): string {
  let m = String(mime ?? '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (!m && name) m = BY_EXT[fileExtension(name)] ?? '';
  return PREVIEW_TYPES.test(m) ? m : 'application/octet-stream';
}

const BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  pdf: 'application/pdf',
};

/** The same bytes with a safe type: use before making a blob: URL of anything received. */
export function safeBlob(b: Blob, name?: string): Blob {
  const type = safeMime(b.type, name);
  if (b.type === type) return b;
  return name ? new File([b], safeFileName(name), { type }) : new Blob([b], { type });
}

// ---- (a) File System Access (Chrome / Edge desktop, Android Chrome) ------------------------------------

type SavePicker = (o: { suggestedName?: string }) => Promise<{ createWritable(o?: { keepExistingData?: boolean }): Promise<Writable> }>;

export const canPickSaveFile = (): boolean => typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';

/**
 * Asks where to save (must run inside a tap, e.g. the Accept button), then writes there directly.
 * Throws AbortError if the person closes the picker.
 */
export async function pickSaveSink(suggestedName: string): Promise<FileSink> {
  const pick = (globalThis as unknown as { showSaveFilePicker: SavePicker }).showSaveFilePicker;
  const handle = await pick({ suggestedName: safeFileName(suggestedName) });
  // keepExistingData: a resumed transfer keeps what was written before the break.
  const w = await handle.createWritable({ keepExistingData: true });
  return writableSink(w, async () => ({ where: 'picked' }));
}

// ---- (b) OPFS: the app's private file area (Safari / iPhone, and others) --------------------------------

const OPFS_DIR = 'p2p-files';

interface DirHandle {
  getDirectoryHandle(n: string, o?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(
    n: string,
    o?: { create?: boolean },
  ): Promise<{ createWritable?(o?: { keepExistingData?: boolean }): Promise<Writable>; getFile(): Promise<File> }>;
  removeEntry(n: string): Promise<void>;
}

async function opfsDir(): Promise<DirHandle> {
  const storage = (globalThis.navigator as Navigator | undefined)?.storage as { getDirectory?: () => Promise<DirHandle> } | undefined;
  if (!storage?.getDirectory) throw new Error('No private file area in this browser.');
  return (await storage.getDirectory()).getDirectoryHandle(OPFS_DIR, { create: true });
}

/**
 * OPFS needs createWritable() on the main thread (Chrome 102+, Firefox 111+, Safari 26+). Older
 * Safari only offers createSyncAccessHandle() inside a worker, which this one-file page's content
 * policy does not allow yet (see the integration note).
 */
export async function opfsSupported(): Promise<boolean> {
  try {
    const dir = await opfsDir();
    const h = await dir.getFileHandle('.probe', { create: true });
    const ok = typeof h.createWritable === 'function';
    await dir.removeEntry('.probe').catch(() => undefined);
    return ok;
  } catch {
    return false;
  }
}

/** Writes into the app's private file area as `<id>-<name>`. Afterwards: shareOrDownload(result.file). */
export async function opfsSink(id: string, name: string): Promise<FileSink> {
  const dir = await opfsDir();
  const fname = `${id}-${safeFileName(name)}`.slice(0, 220);
  const h = await dir.getFileHandle(fname, { create: true });
  if (!h.createWritable) throw new Error('This browser cannot write big files yet.');
  const w = await h.createWritable({ keepExistingData: true });
  return writableSink(
    w,
    // OPFS gives the File a type from its extension (text/html for .html): hand it out with a safe one.
    async () => ({ file: safeBlob(await h.getFile(), fname), where: 'opfs', opfsName: fname }),
    () => dir.removeEntry(fname).catch(() => undefined),
  );
}

/**
 * A received file in the private file area, by its name (ChatMessage.opfs), with a safe type; null if
 * it is gone. The File is backed by the disk: nothing is loaded into memory.
 */
export async function opfsFile(opfsName: string): Promise<File | null> {
  try {
    const f = await (await (await opfsDir()).getFileHandle(opfsName)).getFile();
    return safeBlob(f, opfsName.replace(/^[0-9a-f]+-/, '')) as File;
  } catch {
    return null;
  }
}

/**
 * Moves a file kept inside the database into the private file area (BUG-7: older versions stored the
 * whole received file in IndexedDB). Returns its name there, or null if this browser can't.
 */
export async function blobToOpfs(blob: Blob, id: string, name: string): Promise<string | null> {
  try {
    const dir = await opfsDir();
    const fname = `${id}-${safeFileName(name)}`.slice(0, 220);
    const h = await dir.getFileHandle(fname, { create: true });
    if (!h.createWritable) return null;
    const w = await h.createWritable();
    try {
      for (let off = 0; off < blob.size; off += 4 * 1024 * 1024)
        await w.write({ type: 'write', position: off, data: new Uint8Array(await blob.slice(off, off + 4 * 1024 * 1024).arrayBuffer()) });
      await w.close();
    } catch (e) {
      await w.abort().catch(() => undefined);
      await dir.removeEntry(fname).catch(() => undefined);
      throw e;
    }
    return fname;
  } catch {
    return null;
  }
}

/** Deletes a received file from the app's private file area (after it was saved or shared). */
export async function removeOpfsFile(opfsName: string): Promise<void> {
  await (await opfsDir()).removeEntry(opfsName).catch(() => undefined);
}

// Chrome, Edge and other Chromium browsers (Mac, Windows, Android) share only these file types, at
// most 50 MB, and answer anything else with NotAllowedError "Permission denied" (Chromium
// chrome/browser/webshare/share_service_impl.cc: the extension AND the type must both be allowed).
// An iPhone photo is HEIC and an iPhone video is .MOV: neither is allowed, so Share there must save.
const CHROMIUM_SHARE_EXT = new Set(
  'avif bmp css csv flac gif htm html ico jfif jpeg jpg m4a m4v mp3 mp4 mpeg mpg oga ogg ogm ogv opus pdf pjp pjpeg png shtm shtml svg svgz text tif tiff txt wav weba webm webp xbm'.split(' '),
);
const CHROMIUM_SHARE_TYPES = new Set(
  'application/pdf audio/flac audio/mp3 audio/mpeg audio/ogg audio/wav audio/webm audio/x-m4a image/avif image/bmp image/gif image/jpeg image/png image/svg+xml image/tiff image/webp image/x-icon image/x-ms-bmp image/x-xbitmap text/comma-separated-values text/css text/csv text/html text/plain video/mp4 video/mpeg video/ogg video/webm'.split(' '),
);
export const CHROMIUM_SHARE_MAX = 50 * 1024 * 1024;

/** True when a Chromium browser's share sheet takes this file (name, type and size). */
export function chromiumCanShare(name: string, type: string, size: number): boolean {
  return CHROMIUM_SHARE_EXT.has(fileExtension(name)) && CHROMIUM_SHARE_TYPES.has(type) && size <= CHROMIUM_SHARE_MAX;
}

/** Chrome, Edge, Opera, Samsung Internet… (not Chrome on iPhone: that is Safari inside). */
export function isChromium(nav: { userAgent?: string; userAgentData?: { brands?: { brand: string }[] } } | undefined): boolean {
  if (nav?.userAgentData?.brands?.some((b) => /Chromium/i.test(b.brand))) return true;
  const ua = nav?.userAgent ?? '';
  return /Chrome\/\d/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

/**
 * "Save / Share": the share sheet where this file can be shared (iPhone: "Save to Files"), else a
 * download. The File from OPFS is backed by the disk, so this does not load it into memory.
 * 'downloaded' also when the browser can't share this kind of file (the screen says so).
 */
export async function shareOrDownload(file: Blob, name: string): Promise<'shared' | 'downloaded'> {
  const type = safeMime(file.type, name);
  const f = file instanceof File && file.type === type && file.name === safeFileName(name) ? file : new File([file], safeFileName(name), { type });
  const nav = globalThis.navigator as (Navigator & { canShare?: (d: ShareData) => boolean }) | undefined;
  const allowed = !isChromium(nav as Parameters<typeof isChromium>[0]) || chromiumCanShare(f.name, type, f.size);
  if (allowed && nav?.canShare?.({ files: [f] }) && nav.share) {
    try {
      await nav.share({ files: [f] });
      return 'shared';
    } catch (e) {
      // "Permission denied": this browser won't share this file. Save it instead (never a dead end).
      if ((e as { name?: string })?.name !== 'NotAllowedError') throw e;
    }
  }
  const url = URL.createObjectURL(f);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(name);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}
