import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTransfers, type TransferInfo } from '../../src/net/files';
import {
  BinaryPort,
  NativeFilesError,
  READ_BLOCK,
  WRITE_HEADER,
  _resetForTests,
  blockReader,
  canSaveToPhotos,
  cleanupNativeFiles,
  discardReceived,
  filesSink,
  fromB64,
  joinedSink,
  nativeFileOf,
  photosSink,
  pickOriginals,
  rangeFor,
  rangeRead,
  receiveSink,
  receivedThumb,
  saveToFiles,
  saveToPhotos,
  shareOrOpen,
  toB64,
} from '../../src/native/nativeFiles';
import { chromiumCanShare, isChromium } from '../../src/core/sinks';
import { memPair, rng, until } from './memlink';

function randomBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  const r = rng(seed);
  for (let i = 0; i < n; i++) out[i] = (r() * 256) | 0;
  return out;
}

// ---- a pretend phone: the NativeFiles plugin, its binary port and its local server ----------------

interface FakeOpts {
  platform?: 'android' | 'ios';
  binary?: boolean;
  range?: boolean;
  /** The local server ignores Range (answers 200 with the whole file). */
  serverIgnoresRange?: boolean;
}

function fakePhone(o: FakeOpts = {}) {
  const platform = o.platform ?? 'android';
  const gallery: { name: string; bytes: Uint8Array; mime: string }[] = [];
  const handles = new Map<number, { bytes: Uint8Array; name: string; mime: string; path?: string; writing?: boolean }>();
  const received = new Map<string, Uint8Array>();
  const saved: { to: 'photos' | 'files'; ref: string; name: string; mime: string; bytes: Uint8Array }[] = [];
  const calls: Record<string, number> = {};
  let next = 1;
  const count = (k: string) => (calls[k] = (calls[k] ?? 0) + 1);
  const plugin = {
    pickResult: null as null | 'cancel' | 'denied',
    photosDenied: false,
    filesCancel: false,
    info: vi.fn(async () => ({ binary: !!o.binary, range: !!o.range, platform })),
    pick: vi.fn(async (_a: { kind: string; multiple: boolean; video: boolean }) => {
      count('pick');
      if (plugin.pickResult === 'cancel') throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      if (plugin.pickResult === 'denied') throw Object.assign(new Error('No camera access.'), { code: 'denied' });
      return {
        files: gallery.map((g) => {
          const handle = next++;
          const path = platform === 'ios' ? `/tmp/picked/${handle}.bin` : undefined;
          handles.set(handle, { bytes: g.bytes, name: g.name, mime: g.mime, path });
          return { handle, name: g.name, size: g.bytes.length, mime: g.mime, path };
        }),
      };
    }),
    read: vi.fn(async (a: { handle: number; offset: number; length: number }) => {
      count('read');
      const h = handles.get(a.handle);
      if (!h) throw Object.assign(new Error('gone'), { code: 'missing' });
      return { data: toB64(h.bytes.slice(a.offset, a.offset + a.length)) };
    }),
    release: vi.fn(async (a: { handle: number }) => void handles.delete(a.handle)),
    create: vi.fn(async (a: { name: string; mime: string; size: number }) => {
      const handle = next++;
      handles.set(handle, { bytes: new Uint8Array(a.size), name: a.name, mime: a.mime, writing: true });
      return { handle };
    }),
    write: vi.fn(async (a: { handle: number; offset: number; data: string }) => {
      count('write');
      const h = handles.get(a.handle)!;
      h.bytes.set(fromB64(a.data), a.offset);
    }),
    finish: vi.fn(async (a: { handle: number; size: number }) => {
      const h = handles.get(a.handle)!;
      handles.delete(a.handle);
      const ref = `r${a.handle}/${h.name}`;
      received.set(ref, h.bytes);
      return { ref, size: h.bytes.length };
    }),
    abort: vi.fn(async (a: { handle: number }) => void handles.delete(a.handle)),
    saveToPhotos: vi.fn(async (a: { ref: string; name: string; mime: string }) => {
      if (plugin.photosDenied) throw Object.assign(new Error('P2P Talk is not allowed to add to Photos.'), { code: 'denied' });
      saved.push({ to: 'photos', ...a, bytes: received.get(a.ref)! });
    }),
    saveToFiles: vi.fn(async (a: { ref: string; name: string; mime: string }) => {
      if (plugin.filesCancel) return { saved: false };
      saved.push({ to: 'files', ...a, bytes: received.get(a.ref)! });
      return { saved: true };
    }),
    share: vi.fn(async (_a: { ref: string; name: string; mime: string }) => undefined),
    remove: vi.fn(async (a: { ref: string }) => void received.delete(a.ref)),
    cleanup: vi.fn(async (_a: { keep?: string[] }) => undefined),
  };

  // The Android page object: JSON read requests, ArrayBuffer writes; replies by id.
  const port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage(m: string | ArrayBuffer) {
      queueMicrotask(() => {
        if (typeof m === 'string') {
          count('portRead');
          const r = JSON.parse(m) as { id: number; h: number; o: number; n: number };
          const h = handles.get(r.h);
          if (!h) return port.onmessage?.({ data: JSON.stringify({ id: r.id, err: 'This file is no longer on this phone.', code: 'missing' }) });
          const data = h.bytes.slice(r.o, r.o + r.n);
          const out = new Uint8Array(4 + data.length);
          new DataView(out.buffer).setUint32(0, r.id, true);
          out.set(data, 4);
          port.onmessage?.({ data: out.buffer });
        } else {
          count('portWrite');
          const v = new DataView(m);
          const id = v.getUint32(4, true);
          const h = handles.get(v.getUint32(8, true))!;
          h.bytes.set(new Uint8Array(m, WRITE_HEADER), v.getFloat64(16, true));
          port.onmessage?.({ data: JSON.stringify({ id, ok: true }) });
        }
      });
    },
  };

  // The local server: /_capacitor_file_/<path>, honours Range unless told not to.
  const fetchFn = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    count('fetch');
    const path = url.replace('capacitor://localhost/_capacitor_file_', '');
    const h = [...handles.values()].find((x) => x.path === path);
    if (!h) return new Response(null, { status: 404 });
    const range = init?.headers?.Range;
    if (!range || o.serverIgnoresRange) return new Response(h.bytes.slice(), { status: 200 });
    const [a, b] = range.replace('bytes=', '').split('-').map(Number);
    return new Response(h.bytes.slice(a, b + 1), { status: 206 });
  });

  const cap = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    isPluginAvailable: (n: string) => n === 'NativeFiles',
    convertFileSrc: (p: string) => `capacitor://localhost/_capacitor_file_${p}`,
    Plugins: { NativeFiles: plugin },
  };
  const G = globalThis as Record<string, unknown>;
  G.Capacitor = cap;
  if (o.binary) G.P2PFiles = port;
  vi.stubGlobal('fetch', fetchFn);
  return { plugin, port, gallery, handles, received, saved, calls, fetchFn };
}

beforeEach(() => _resetForTests());
afterEach(() => {
  const G = globalThis as Record<string, unknown>;
  delete G.Capacitor;
  delete G.P2PFiles;
  delete G.document;
  vi.unstubAllGlobals();
});

/** Byte arrays equal (without vitest's huge diff for big arrays). */
function same(a: Uint8Array | undefined, b: Uint8Array): void {
  expect(a, 'missing').toBeDefined();
  expect(a!.length, 'length').toBe(b.length);
  let i = 0;
  while (i < b.length && a![i] === b[i]) i++;
  expect(i, 'first different byte').toBe(b.length);
}

async function readAll(src: { size: number; read(o: number, n: number): Promise<Uint8Array> }, step = 256 * 1024): Promise<Uint8Array> {
  const out = new Uint8Array(src.size);
  for (let off = 0; off < src.size; off += step) {
    const d = await src.read(off, Math.min(step, src.size - off));
    out.set(d, off);
  }
  return out;
}

// ---- pure helpers -------------------------------------------------------------------------------------

describe('nativeFiles: Range math', () => {
  it('turns offset + length into an inclusive byte range, clamped to the file', () => {
    expect(rangeFor(0, 10, 100)).toEqual({ header: 'bytes=0-9', start: 0, end: 9, length: 10 });
    expect(rangeFor(90, 50, 100)).toEqual({ header: 'bytes=90-99', start: 90, end: 99, length: 10 });
    expect(rangeFor(5 * 2 ** 30, 262144, 6 * 2 ** 30)?.header).toBe(`bytes=${5 * 2 ** 30}-${5 * 2 ** 30 + 262143}`);
  });
  it('empty or past the end: no request', () => {
    expect(rangeFor(10, 0, 100)).toBeNull();
    expect(rangeFor(100, 5, 100)).toBeNull();
    expect(rangeFor(200, 5, 100)).toBeNull();
  });
  it('refuses negative or non-numbers', () => {
    expect(() => rangeFor(-1, 5, 100)).toThrow(RangeError);
    expect(() => rangeFor(0, -5, 100)).toThrow(RangeError);
    expect(() => rangeFor(NaN, 5, 100)).toThrow(RangeError);
  });

  it('rangeRead: 206 gives the piece; a server that ignores Range is refused unless it is the whole file', async () => {
    const bytes = randomBytes(1000, 3);
    const ok = vi.fn(async (_u: string, i?: RequestInit) => {
      const [a, b] = String((i!.headers as Record<string, string>).Range).replace('bytes=', '').split('-').map(Number);
      return new Response(bytes.slice(a, b + 1), { status: 206 });
    });
    same(await rangeRead('u', 100, 50, 1000, ok as unknown as typeof fetch), bytes.slice(100, 150));
    same(await rangeRead('u', 990, 50, 1000, ok as unknown as typeof fetch), bytes.slice(990));
    expect(await rangeRead('u', 1000, 50, 1000, ok as unknown as typeof fetch)).toEqual(new Uint8Array(0));
    expect(ok).toHaveBeenCalledTimes(2); // nothing fetched for an empty piece

    const whole = (async () => new Response(bytes.slice(), { status: 200 })) as unknown as typeof fetch;
    same(await rangeRead('u', 0, 1000, 1000, whole), bytes);
    await expect(rangeRead('u', 100, 50, 1000, whole)).rejects.toBeInstanceOf(NativeFilesError);

    const short = (async () => new Response(bytes.slice(0, 10), { status: 206 })) as unknown as typeof fetch;
    await expect(rangeRead('u', 0, 50, 1000, short)).rejects.toBeInstanceOf(NativeFilesError);
  });

  it('base64 both ways', () => {
    const b = randomBytes(100_003, 9);
    same(fromB64(toB64(b)), b);
    expect(toB64(new Uint8Array(0))).toBe('');
  });
});

describe('nativeFiles: block reader', () => {
  it('any offset and length give exactly those bytes (across block edges)', async () => {
    const bytes = randomBytes(5 * 1000 + 7, 4);
    const read = blockReader(bytes.length, async (o, n) => bytes.slice(o, o + n), 1000);
    const r = rng(11);
    for (let i = 0; i < 200; i++) {
      const off = Math.floor(r() * bytes.length);
      const len = Math.floor(r() * 2500);
      expect(await read(off, len)).toEqual(bytes.slice(off, Math.min(bytes.length, off + len)));
    }
    expect(await read(bytes.length, 10)).toEqual(new Uint8Array(0));
    await expect(read(-1, 10)).rejects.toThrow(RangeError);
  });

  it('sequential 256 KB reads cost about one native call per 1 MB block', async () => {
    const size = 10 * READ_BLOCK + 12345;
    const bytes = randomBytes(size, 5);
    const fetchBlock = vi.fn(async (o: number, n: number) => bytes.slice(o, o + n));
    const read = blockReader(size, fetchBlock);
    same(await readAll({ size, read }), bytes);
    expect(fetchBlock).toHaveBeenCalledTimes(11); // 10 full blocks + the last part, each once
  });

  it('a resume reads from the middle; a failed block is fetched again', async () => {
    const bytes = randomBytes(3 * 1000, 6);
    let fail = true;
    const read = blockReader(bytes.length, async (o, n) => {
      if (o === 1000 && fail) {
        fail = false;
        throw new Error('disk busy');
      }
      return bytes.slice(o, o + n);
    }, 1000);
    await expect(read(1200, 100)).rejects.toThrow('disk busy');
    same(await read(1200, 100), bytes.slice(1200, 1300));
    same(await read(0, 3000), bytes);
  });

  it('a block shorter than expected (file changed) is an error, not wrong bytes', async () => {
    const read = blockReader(2000, async () => new Uint8Array(10), 1000);
    await expect(read(0, 100)).rejects.toBeInstanceOf(NativeFilesError);
  });
});

describe('nativeFiles: sink offsets', () => {
  function writer() {
    const file = new Uint8Array(10_000);
    const writes: [number, number][] = [];
    let finished = false;
    let aborted = false;
    return {
      file,
      writes,
      get finished() {
        return finished;
      },
      get aborted() {
        return aborted;
      },
      w: {
        open: async () => 7,
        write: async (_h: number, off: number, d: Uint8Array) => {
          writes.push([off, d.length]);
          file.set(d, off);
        },
        finish: async () => {
          finished = true;
          return { ref: 'r/x', size: file.length };
        },
        abort: async () => void (aborted = true),
      },
    };
  }

  it('joins pieces that follow each other; a different offset first sends what waits', async () => {
    const x = writer();
    const sink = joinedSink(10_000, x.w, async () => ({ where: 'memory' }), 3000);
    const b = randomBytes(10_000, 8);
    for (let off = 0; off < 6000; off += 1000) await sink.write(off, b.subarray(off, off + 1000));
    expect(x.writes).toEqual([
      [0, 3000],
      [3000, 3000],
    ]);
    // A resume asks again from 5000 (already written): written again in the same place.
    await sink.write(5000, b.subarray(5000, 6000));
    await sink.write(6000, b.subarray(6000, 10_000));
    await sink.close();
    expect(x.writes).toEqual([
      [0, 3000],
      [3000, 3000],
      [5000, 5000],
    ]);
    same(x.file, b);
    expect(x.finished).toBe(true);
  });

  it('writes past the end or at a bad offset are refused', async () => {
    const x = writer();
    const sink = joinedSink(10_000, x.w, async () => ({ where: 'memory' }));
    await expect(sink.write(9_999, new Uint8Array(2))).rejects.toThrow('past the end');
    await expect(sink.write(-1, new Uint8Array(2))).rejects.toThrow(RangeError);
    await expect(sink.write(1.5, new Uint8Array(2))).rejects.toThrow(RangeError);
  });

  it('the caller may reuse its buffer after write()', async () => {
    const x = writer();
    const sink = joinedSink(10_000, x.w, async () => ({ where: 'memory' }));
    const buf = new Uint8Array(100).fill(1);
    await sink.write(0, buf);
    buf.fill(2);
    await sink.write(100, buf);
    await sink.close();
    expect(x.file.subarray(0, 100).every((v) => v === 1)).toBe(true);
    expect(x.file.subarray(100, 200).every((v) => v === 2)).toBe(true);
  });

  it('abort throws away what waits and deletes the temporary file; writes after it fail', async () => {
    const x = writer();
    const sink = joinedSink(10_000, x.w, async () => ({ where: 'memory' }));
    await sink.write(0, new Uint8Array(100));
    await sink.abort();
    expect(x.aborted).toBe(true);
    expect(x.writes).toEqual([]);
    await expect(sink.write(100, new Uint8Array(1))).rejects.toThrow('closed');
    await sink.abort(); // twice is fine
  });

  it('an empty file: close() still makes it', async () => {
    const x = writer();
    const sink = joinedSink(0, x.w, async () => ({ where: 'memory' }));
    await sink.close();
    expect(x.finished).toBe(true);
  });
});

// ---- in the app -------------------------------------------------------------------------------------

describe('nativeFiles: picking in the app', () => {
  it('Android, binary port: the picked bytes are the original bytes (random access, no base64)', async () => {
    const phone = fakePhone({ platform: 'android', binary: true });
    const video = randomBytes(3 * READ_BLOCK + 999, 21);
    phone.gallery.push({ name: 'IMG_1.heic', bytes: randomBytes(70_001, 20), mime: 'image/heic' }, { name: 'VID_2.mp4', bytes: video, mime: 'video/mp4' });
    const picked = await pickOriginals('media');
    expect(phone.plugin.pick).toHaveBeenCalledWith({ kind: 'media', multiple: true, video: false });
    expect(picked.map((p) => [p.name, p.size, p.mime])).toEqual([
      ['IMG_1.heic', 70_001, 'image/heic'],
      ['VID_2.mp4', video.length, 'video/mp4'],
    ]);
    same(await readAll(picked[1]), video);
    same(await picked[1].read(READ_BLOCK - 5, 10), video.slice(READ_BLOCK - 5, READ_BLOCK + 5)); // resume in the middle
    same(await readAll(picked[0]), phone.gallery[0].bytes);
    expect(phone.calls.read ?? 0).toBe(0);
    expect(phone.calls.portRead).toBeGreaterThan(0);
    await picked[0].release();
    await picked[0].release();
    expect(phone.plugin.release).toHaveBeenCalledTimes(1);
  });

  it('iPhone: reads through the local server with Range; HEIC stays HEIC', async () => {
    const phone = fakePhone({ platform: 'ios', range: true });
    const heic = randomBytes(2 * READ_BLOCK + 5, 22);
    phone.gallery.push({ name: 'IMG_0001.HEIC', bytes: heic, mime: 'image/heic' });
    const [p] = await pickOriginals('media', { multiple: false });
    expect(phone.plugin.pick).toHaveBeenCalledWith({ kind: 'media', multiple: false, video: false });
    expect(p.mime).toBe('image/heic');
    same(await readAll(p), heic);
    expect(phone.calls.fetch).toBe(3);
    expect(phone.calls.read ?? 0).toBe(0);
  });

  it('iPhone: if the local server ignores Range, it reads through the plugin instead', async () => {
    const phone = fakePhone({ platform: 'ios', range: true, serverIgnoresRange: true });
    const v = randomBytes(2 * READ_BLOCK + 5, 23);
    phone.gallery.push({ name: 'v.mov', bytes: v, mime: 'video/quicktime' });
    const [p] = await pickOriginals('files');
    same(await readAll(p), v);
    expect(phone.calls.fetch).toBe(1); // tried once, then the plugin
    expect(phone.calls.read).toBe(3);
  });

  it('no binary port and no range: base64 plugin reads', async () => {
    const phone = fakePhone({ platform: 'android' });
    const f = randomBytes(1_500_000, 24);
    phone.gallery.push({ name: 'a.pdf', bytes: f, mime: 'application/pdf' });
    const [p] = await pickOriginals('files');
    same(await readAll(p), f);
    expect(phone.calls.read).toBe(2);
  });

  it('the person closes the picker: [] (not an error); camera is one item', async () => {
    const phone = fakePhone();
    phone.plugin.pickResult = 'cancel';
    expect(await pickOriginals('camera')).toEqual([]);
    expect(phone.plugin.pick).toHaveBeenCalledWith({ kind: 'camera', multiple: false, video: false });
  });

  it('camera refused: a plain error with code denied', async () => {
    const phone = fakePhone();
    phone.plugin.pickResult = 'denied';
    const e = await pickOriginals('camera', { video: true }).catch((x) => x);
    expect(e).toBeInstanceOf(NativeFilesError);
    expect(e.code).toBe('denied');
    expect(phone.plugin.pick).toHaveBeenCalledWith({ kind: 'camera', multiple: false, video: true });
  });

  it('a picked file that is gone: reading fails with a plain error', async () => {
    const phone = fakePhone({ binary: true });
    phone.gallery.push({ name: 'x.bin', bytes: randomBytes(100, 1), mime: '' });
    const [p] = await pickOriginals('files');
    expect(p.mime).toBe('application/octet-stream');
    phone.handles.clear();
    const e = await p.read(0, 10).catch((x) => x);
    expect(e).toBeInstanceOf(NativeFilesError);
    expect(e.code).toBe('missing');
  });
});

describe('nativeFiles: receiving and saving in the app', () => {
  it('receiveSink (Android binary): pieces land in place; Save to Photos, Save to Files, Share, remove', async () => {
    const phone = fakePhone({ platform: 'android', binary: true });
    const b = randomBytes(2 * 1024 * 1024 + 77, 31);
    const sink = receiveSink('clip.mp4', b.length, 'video/mp4');
    for (let off = 0; off < b.length; off += 262144) await sink.write(off, b.subarray(off, off + 262144));
    const r = await sink.close();
    const f = nativeFileOf(r)!;
    expect(f).toMatchObject({ name: 'clip.mp4', size: b.length, mime: 'video/mp4' });
    same(phone.received.get(f.ref), b);
    expect(phone.calls.write ?? 0).toBe(0);
    expect(phone.calls.portWrite).toBe(3); // 1 MB + 1 MB + the rest

    await saveToPhotos(r, 'clip.mp4', 'video/mp4');
    expect(await saveToFiles(r, 'clip.mp4', 'video/mp4')).toBe(true);
    expect(phone.saved.map((s) => [s.to, s.name])).toEqual([
      ['photos', 'clip.mp4'],
      ['files', 'clip.mp4'],
    ]);
    same(phone.saved[0].bytes, b);
    expect(await shareOrOpen(r, 'clip.mp4', 'video/mp4')).toBe('shared');
    await discardReceived(r);
    expect(phone.received.size).toBe(0);
  });

  it('iPhone: base64 writes, joined into 1 MB calls', async () => {
    const phone = fakePhone({ platform: 'ios', range: true });
    const b = randomBytes(3 * 1024 * 1024, 32);
    const sink = receiveSink('IMG_2.HEIC', b.length, 'image/heic');
    for (let off = 0; off < b.length; off += 262144) await sink.write(off, b.subarray(off, off + 262144));
    const f = nativeFileOf(await sink.close())!;
    same(phone.received.get(f.ref), b);
    expect(phone.calls.write).toBe(3);
  });

  it('photosSink: saved into the gallery on close, and the app copy removed', async () => {
    const phone = fakePhone({ binary: true });
    const b = randomBytes(5000, 33);
    const sink = photosSink('p.jpg', b.length, 'image/jpeg');
    await sink.write(0, b);
    const r = (await sink.close()) as unknown as { saved: unknown };
    expect(r.saved).toBe('photos');
    expect(phone.saved[0]).toMatchObject({ to: 'photos', name: 'p.jpg', mime: 'image/jpeg' });
    same(phone.saved[0].bytes, b);
    expect(phone.received.size).toBe(0);
  });

  it('photosSink: Photos access refused -> close still succeeds, saved false with the reason; the file stays', async () => {
    const phone = fakePhone({ binary: true });
    phone.plugin.photosDenied = true;
    const sink = photosSink('p.jpg', 10, 'image/jpeg');
    await sink.write(0, new Uint8Array(10));
    const r = (await sink.close()) as unknown as { saved: unknown; error: string };
    expect(r.saved).toBe(false);
    expect(r.error).toMatch(/not allowed/);
    expect(phone.received.size).toBe(1);
  });

  it('filesSink: the person closes the folder picker -> saved false, the file stays', async () => {
    const phone = fakePhone({ binary: true });
    phone.plugin.filesCancel = true;
    const sink = filesSink('notes.pdf', 3, 'application/pdf');
    await sink.write(0, new Uint8Array([1, 2, 3]));
    const r = (await sink.close()) as unknown as { saved: unknown };
    expect(r.saved).toBe(false);
    expect(phone.received.size).toBe(1);
  });

  it('a cancelled transfer deletes the temporary file', async () => {
    const phone = fakePhone({ binary: true });
    const sink = receiveSink('big.mov', 10_000_000, 'video/quicktime');
    await sink.write(0, randomBytes(262144, 1));
    await sink.abort();
    expect(phone.plugin.create).toHaveBeenCalledTimes(1); // the temporary file was made at the first write
    expect(phone.plugin.abort).toHaveBeenCalledTimes(1); // and deleted
    expect(phone.handles.size).toBe(0);
    expect(phone.received.size).toBe(0);
  });

  it('Save to Photos only for images and videos the gallery takes', () => {
    fakePhone({ platform: 'android' });
    expect(canSaveToPhotos('image/jpeg')).toBe(true);
    expect(canSaveToPhotos('video/x-matroska')).toBe(true);
    expect(canSaveToPhotos('application/pdf')).toBe(false);
    fakePhone({ platform: 'ios' });
    expect(canSaveToPhotos('image/heic')).toBe(true);
    expect(canSaveToPhotos('video/quicktime')).toBe(true);
    expect(canSaveToPhotos('Video/MP4; codecs=avc1')).toBe(true);
    expect(canSaveToPhotos('video/webm')).toBe(false);
    expect(canSaveToPhotos('application/zip')).toBe(false);
  });

  it('saving a PDF to Photos is refused with a plain message', async () => {
    fakePhone();
    const e = await saveToPhotos({ where: 'native', native: { ref: 'r/x', name: 'x.pdf', size: 1, mime: 'application/pdf' } } as never, 'x.pdf', 'application/pdf').catch((x) => x);
    expect(e.code).toBe('unsupported');
  });

  it('cleanup at start passes the files to keep', async () => {
    const phone = fakePhone();
    await cleanupNativeFiles(['r1/a.jpg']);
    await cleanupNativeFiles();
    expect(phone.plugin.cleanup.mock.calls).toEqual([[{ keep: ['r1/a.jpg'] }], [{}]]);
  });

  it('a 3 MB file through the real files engine: picked on one phone, received on the other, identical', async () => {
    const phone = fakePhone({ binary: true });
    const bytes = randomBytes(3 * 1024 * 1024 + 4321, 40);
    phone.gallery.push({ name: 'VID.mp4', bytes, mime: 'video/mp4' });
    const [src] = await pickOriginals('media');
    const A = new FileTransfers('222222222222222222222222', { stallMs: 200, progressMs: 0 });
    const B = new FileTransfers('111111111111111111111111', { stallMs: 200, progressMs: 0 });
    B.on('offer', (t) => void B.accept(t.id, receiveSink(t.name, t.size, t.mime)));
    let done: TransferInfo | null = null;
    B.on('done', (t) => (done = t));
    const ctl = memPair('222222222222222222222222', '111111111111111111111111');
    const open = (from: FileTransfers, to: FileTransfers) => async () => {
      const d = memPair(from.peerId, to.peerId);
      to.addDataChannel(d.b);
      return d.a;
    };
    A.attach(ctl.a, open(A, B));
    B.attach(ctl.b, open(B, A));
    await A.send(src);
    await until(() => !!done, 20_000);
    const f = nativeFileOf(done!.result)!;
    expect(f.size).toBe(bytes.length);
    same(phone.received.get(f.ref), bytes);
    A.dispose();
    B.dispose();
  });
});

describe('nativeFiles: BinaryPort', () => {
  it('ignores stray messages and maps native errors to plain ones', async () => {
    const sent: unknown[] = [];
    const p = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (m: unknown) => void sent.push(m) };
    const port = new BinaryPort(p);
    const r = port.read(1, 0, 10);
    p.onmessage!({ data: 'not json' });
    p.onmessage!({ data: new ArrayBuffer(2) });
    p.onmessage!({ data: JSON.stringify({ id: 999, ok: true }) });
    p.onmessage!({ data: JSON.stringify({ id: 1, err: 'There is no room on the phone.', code: 'failed' }) });
    const e = await r.catch((x) => x);
    expect(e).toBeInstanceOf(NativeFilesError);
    expect(e.message).toBe('There is no room on the phone.');
    expect(JSON.parse(sent[0] as string)).toEqual({ op: 'read', id: 1, h: 1, o: 0, n: 10 });
  });
});

// ---- in a browser -------------------------------------------------------------------------------------

/** A tiny stand-in for document: <input type=file> and <a download>. */
function fakeDocument(choose: File[] | 'cancel') {
  const made: Record<string, unknown>[] = [];
  const doc = {
    body: { appendChild: () => undefined },
    createElement(tag: string) {
      const el = Object.assign(new EventTarget(), {
        tag,
        type: '',
        accept: '',
        multiple: false,
        href: '',
        download: '',
        files: null as File[] | null,
        style: {} as Record<string, string>,
        attrs: {} as Record<string, string>,
        setAttribute(k: string, v: string) {
          this.attrs[k] = v;
        },
        remove() {},
        click() {
          if (tag !== 'input') return;
          queueMicrotask(() => {
            if (choose === 'cancel') this.dispatchEvent(new Event('cancel'));
            else {
              this.files = choose;
              this.dispatchEvent(new Event('change'));
            }
          });
        },
      });
      made.push(el);
      return el;
    },
  };
  (globalThis as Record<string, unknown>).document = doc;
  return made;
}

describe('nativeFiles: browser fallbacks', () => {
  it('media: <input type=file accept=image/*,video/* multiple>; the files read as they are', async () => {
    const f = new File([randomBytes(1000, 50) as Uint8Array<ArrayBuffer>], 'IMG.HEIC', { type: 'image/heic' });
    const made = fakeDocument([f]);
    const [p] = await pickOriginals('media');
    expect(made[0]).toMatchObject({ type: 'file', accept: 'image/*,video/*', multiple: true });
    expect([p.name, p.size, p.mime]).toEqual(['IMG.HEIC', 1000, 'image/heic']);
    expect(await p.read(10, 5)).toEqual(new Uint8Array(await f.slice(10, 15).arrayBuffer()));
    await p.release();
  });

  it('camera: capture, one item; files: any type', async () => {
    const made = fakeDocument([]);
    await pickOriginals('camera');
    expect(made[0]).toMatchObject({ accept: 'image/*', multiple: false, attrs: { capture: 'environment' } });
    await pickOriginals('camera', { video: true });
    expect(made[1]).toMatchObject({ accept: 'video/*' });
    await pickOriginals('files');
    expect(made[2]).toMatchObject({ accept: '', multiple: true });
  });

  it('closing the chooser gives []', async () => {
    fakeDocument('cancel');
    expect(await pickOriginals('files')).toEqual([]);
  });

  it('no Save to Photos in a browser', () => {
    expect(canSaveToPhotos('image/jpeg')).toBe(false);
  });

  it('receiveSink falls back to memory for small files; Save to Files downloads; Share falls back too', async () => {
    const made = fakeDocument([]);
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
    const sink = receiveSink('a.txt', 3, 'text/plain');
    await sink.write(0, new Uint8Array([104, 105, 33]));
    const r = await sink.close();
    expect(r.where).toBe('memory');
    expect(await r.file!.text()).toBe('hi!');
    expect(await saveToFiles(r, 'a.txt', 'text/plain')).toBe(true);
    expect(made.at(-1)).toMatchObject({ tag: 'a', download: 'a.txt', href: 'blob:x' });
    vi.stubGlobal('navigator', {
      canShare: () => true,
      share: async () => {
        throw Object.assign(new Error('closed'), { name: 'AbortError' });
      },
    });
    expect(await shareOrOpen(r, 'a.txt', 'text/plain')).toBe('cancelled');
    await expect(saveToPhotos(r, 'a.txt', 'text/plain')).rejects.toBeInstanceOf(NativeFilesError);
  });

  it('a big file in a browser without a private file area: a plain error on the first write', async () => {
    const sink = receiveSink('big.mov', 200 * 1024 * 1024, 'video/quicktime');
    const e = await sink.write(0, new Uint8Array(1)).catch((x) => x);
    expect(e).toBeInstanceOf(NativeFilesError);
    expect(e.message).toMatch(/too big for this browser/);
  });
});

// ---- received photos: a preview made by the phone; Share where the browser can't share the type ------

describe('nativeFiles: previews of received photos and videos (apps)', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

  async function received(name: string, mime: string, phone: ReturnType<typeof fakePhone>) {
    const b = randomBytes(5000, 7);
    const sink = receiveSink(name, b.length, mime);
    await sink.write(0, b);
    const r = await sink.close();
    return { r, b, ref: nativeFileOf(r)!.ref, phone };
  }

  it('a HEIC photo: the phone makes a small JPEG; the received file is untouched; asked once', async () => {
    const phone = fakePhone({ platform: 'ios', range: true });
    const thumb = vi.fn(async (_a: { ref: string; mime: string; max: number }) => ({ data: toB64(JPEG) }));
    Object.assign(phone.plugin, { thumb });
    const { r, b, ref } = await received('IMG_0042.HEIC', 'image/heic', phone);
    const t = await receivedThumb(r, 'image/heic', 'IMG_0042.HEIC');
    expect(t?.type).toBe('image/jpeg');
    expect(new Uint8Array(await t!.arrayBuffer())).toEqual(JPEG);
    expect(thumb).toHaveBeenCalledWith({ ref, mime: 'image/heic', max: 360 });
    same(phone.received.get(ref), b); // the original stays as it came
    await receivedThumb(r, 'image/heic', 'IMG_0042.HEIC');
    expect(thumb).toHaveBeenCalledTimes(1);
  });

  it('videos too; not other files; nothing from an older app or a phone that can\'t read it', async () => {
    const phone = fakePhone({ platform: 'android', binary: true });
    const thumb = vi.fn(async (a: { ref: string; mime: string; max: number }) => {
      if (a.mime === 'video/mp4') return { data: toB64(JPEG) };
      throw Object.assign(new Error('No preview for this file.'), { code: 'unsupported' });
    });
    Object.assign(phone.plugin, { thumb });
    const v = await received('clip.mp4', 'video/mp4', phone);
    expect(await receivedThumb(v.r, 'video/mp4', 'clip.mp4')).toBeInstanceOf(Blob);
    const pdf = await received('a.pdf', 'application/pdf', phone);
    expect(await receivedThumb(pdf.r, 'application/pdf', 'a.pdf')).toBeNull();
    const broken = await received('broken.jpg', 'image/jpeg', phone);
    expect(await receivedThumb(broken.r, 'image/jpeg', 'broken.jpg')).toBeNull();
    expect(thumb).toHaveBeenCalledTimes(2); // never for the PDF
    // An older app without thumb(): no preview, no error.
    delete (phone.plugin as { thumb?: unknown }).thumb;
    _resetForTests();
    expect(await receivedThumb(v.r, 'video/mp4', 'clip.mp4')).toBeNull();
  });

  it('only a small JPEG is taken from the phone', async () => {
    const phone = fakePhone({ platform: 'ios', range: true });
    const reply = { data: '' };
    Object.assign(phone.plugin, { thumb: async () => reply });
    const { r } = await received('a.png', 'image/png', phone);
    reply.data = toB64(new TextEncoder().encode('<svg onload=alert(1)>'));
    expect(await receivedThumb(r, 'image/png', 'a.png')).toBeNull();
    const big = new Uint8Array(600 * 1024);
    big.set([0xff, 0xd8, 0xff]);
    reply.data = toB64(big);
    expect(await receivedThumb(r, 'image/png', 'a.png')).toBeNull();
    reply.data = toB64(JPEG);
    expect(await receivedThumb(r, 'image/png', 'a.png')).toBeInstanceOf(Blob);
  });

  it('in a browser: none (the page draws its own from the file)', async () => {
    expect(await receivedThumb({ where: 'memory', file: new Blob([JPEG]) }, 'image/jpeg', 'a.jpg')).toBeNull();
  });
});

describe('nativeFiles: Share in a browser that can\'t share the type (BUG: "Permission denied")', () => {
  const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

  function browser(ua: string, share: (d: ShareData) => Promise<void>) {
    const made = fakeDocument([]);
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
    const nav = { userAgent: ua, canShare: () => true, share: vi.fn(share) };
    vi.stubGlobal('navigator', nav);
    return { made, nav };
  }
  const heic = () => ({ where: 'memory' as const, file: new Blob([new Uint8Array([0, 0, 0, 24])], { type: 'image/heic' }) });

  it('Chrome: an iPhone HEIC photo is saved instead of asking the share sheet (which says "Permission denied")', async () => {
    const { made, nav } = browser(CHROME_MAC, async () => {
      throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    });
    expect(await shareOrOpen(heic(), 'IMG_0042.HEIC', 'image/heic')).toBe('downloaded');
    expect(nav.share).not.toHaveBeenCalled();
    expect(made.at(-1)).toMatchObject({ tag: 'a', download: 'IMG_0042.HEIC', href: 'blob:x' });
  });

  it('Chrome: a JPEG is shared; if the browser still says "Permission denied", it is saved (never an error)', async () => {
    const shared: ShareData[] = [];
    const { made, nav } = browser(CHROME_MAC, async (d) => void shared.push(d));
    const jpg = { where: 'memory' as const, file: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }) };
    expect(await shareOrOpen(jpg, 'photo.jpg', 'image/jpeg')).toBe('shared');
    expect(shared[0].files?.[0].name).toBe('photo.jpg');
    nav.share.mockImplementation(async () => {
      throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    });
    expect(await shareOrOpen(jpg, 'photo.jpg', 'image/jpeg')).toBe('downloaded');
    expect(made.at(-1)).toMatchObject({ tag: 'a', download: 'photo.jpg' });
    nav.share.mockImplementation(async () => {
      throw Object.assign(new Error('Share canceled'), { name: 'AbortError' });
    });
    expect(await shareOrOpen(jpg, 'photo.jpg', 'image/jpeg')).toBe('cancelled');
  });

  it('Safari on iPhone shares a HEIC photo (its share sheet takes it)', async () => {
    const { nav } = browser(SAFARI_IPHONE, async () => undefined);
    expect(await shareOrOpen(heic(), 'IMG_0042.HEIC', 'image/heic')).toBe('shared');
    expect(nav.share).toHaveBeenCalledTimes(1);
  });
});

describe('sinks: which files a Chromium share sheet takes', () => {
  it('JPEG, PNG, WebP, MP4, PDF up to 50 MB; not HEIC, MOV, unknown types, or bigger files', () => {
    expect(chromiumCanShare('a.jpg', 'image/jpeg', 1000)).toBe(true);
    expect(chromiumCanShare('a.PNG', 'image/png', 1000)).toBe(true);
    expect(chromiumCanShare('a.webp', 'image/webp', 1000)).toBe(true);
    expect(chromiumCanShare('a.mp4', 'video/mp4', 1000)).toBe(true);
    expect(chromiumCanShare('a.pdf', 'application/pdf', 1000)).toBe(true);
    expect(chromiumCanShare('IMG_1.HEIC', 'image/heic', 1000)).toBe(false);
    expect(chromiumCanShare('IMG_1.heif', 'image/heif', 1000)).toBe(false);
    expect(chromiumCanShare('IMG_2.MOV', 'video/quicktime', 1000)).toBe(false);
    expect(chromiumCanShare('a.jpg', 'application/octet-stream', 1000)).toBe(false);
    expect(chromiumCanShare('a.jpg', 'image/jpeg', 50 * 1024 * 1024 + 1)).toBe(false);
  });
  it('Chrome, Edge and Android Chrome are Chromium; Safari, Chrome on iPhone and Firefox are not', () => {
    expect(isChromium({ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36' })).toBe(true);
    expect(isChromium({ userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/141.0.0.0 Mobile Safari/537.36' })).toBe(true);
    expect(isChromium({ userAgent: '', userAgentData: { brands: [{ brand: 'Chromium' }] } })).toBe(true);
    expect(isChromium({ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' })).toBe(false);
    expect(isChromium({ userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/141.0 Mobile/15E148 Safari/604.1' })).toBe(false);
    expect(isChromium({ userAgent: 'Mozilla/5.0 (Macintosh; rv:140.0) Gecko/20100101 Firefox/140.0' })).toBe(false);
    expect(isChromium(undefined)).toBe(false);
  });
});
