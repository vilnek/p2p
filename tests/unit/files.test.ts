import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { toHex } from '../../src/core/bytes';
import { FileTransfers, bytesSource, memorySink, type FileTransfersOptions, type MemorySink, type TransferInfo } from '../../src/net/files';
import { memPair, rng, sleep, until, type MemOptions, type MemPair } from './memlink';

const ID_A = '111111111111111111111111';
const ID_B = '222222222222222222222222';

function randomBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  const r = rng(seed);
  for (let i = 0; i < n; i += 4) {
    const v = (r() * 2 ** 32) >>> 0;
    out[i] = v;
    out[i + 1] = v >>> 8;
    out[i + 2] = v >>> 16;
    out[i + 3] = v >>> 24;
  }
  return out;
}

const fast: FileTransfersOptions = { stallMs: 60, progressMs: 0 };

/** Two sides (A sends, B receives) and a way to connect / drop the link between them. */
function setup(opts: FileTransfersOptions = {}, dataOpts: MemOptions = {}, optsB: FileTransfersOptions = {}) {
  const A = new FileTransfers(ID_B, { ...fast, ...opts });
  const B = new FileTransfers(ID_A, { ...fast, ...opts, ...optsB });
  let links: MemPair[] = [];
  let resumes = 0;
  const data: MemPair[] = [];
  const connect = () => {
    const ctl = memPair(ID_B, ID_A);
    links = [ctl];
    const open = (from: FileTransfers, to: FileTransfers) => async () => {
      const d = memPair(from.peerId, to.peerId, dataOpts);
      links.push(d);
      data.push(d);
      to.addDataChannel(d.b);
      return d.a;
    };
    A.attach(ctl.a, open(A, B));
    B.attach(ctl.b, open(B, A));
  };
  const drop = () => {
    links.forEach((l) => l.close());
    A.detach();
    B.detach();
    resumes++;
  };
  const sinks: MemorySink[] = [];
  const offers: TransferInfo[] = [];
  B.on('offer', (t) => offers.push(t));
  const acceptAll = () =>
    B.on('offer', (t) => {
      const s = memorySink(t.size, t.mime);
      sinks.push(s);
      void B.accept(t.id, s);
    });
  const end = () => {
    A.dispose();
    B.dispose();
  };
  return { A, B, connect, drop, sinks, offers, acceptAll, data, end, resumes: () => resumes };
}

describe('files: offer / accept / transfer', () => {
  it('sends 1 MB and both sides end with the same SHA-256', async () => {
    const s = setup();
    s.acceptAll();
    s.connect();
    const bytes = randomBytes(1024 * 1024 + 123, 7);
    const updates: TransferInfo[] = [];
    s.B.on('update', (t) => updates.push(t));
    const done: string[] = [];
    s.A.on('done', () => done.push('A'));
    s.B.on('done', (t) => {
      done.push('B');
      expect(t.result?.where).toBe('memory');
    });
    const id = await s.A.send(bytesSource(bytes, 'photo.jpg', 'image/jpeg'));
    await until(() => done.length === 2);
    expect(toHex(sha256(s.sinks[0].bytes()))).toBe(toHex(sha256(bytes)));
    expect(s.A.get(id)?.state).toBe('done');
    expect(s.B.get(id)?.state).toBe('done');
    expect(s.B.get(id)?.bytes).toBe(bytes.length);
    expect(updates.some((u) => u.state === 'active' && u.bytes > 0)).toBe(true);
    expect(s.offers[0]).toMatchObject({ name: 'photo.jpg', mime: 'image/jpeg', size: bytes.length, state: 'incoming' });
    s.end();
  });

  it('auto-accepts below autoAcceptBelow; asks for bigger files', async () => {
    const auto: MemorySink[] = [];
    const s = setup({ autoAcceptBelow: 300_000, autoSink: async (t) => (auto.push(memorySink(t.size)), auto[auto.length - 1]) });
    s.connect();
    let done = 0;
    s.B.on('done', () => done++);
    await s.A.send(bytesSource(randomBytes(200_000, 2)));
    await until(() => done === 1);
    expect(s.offers.length).toBe(0); // no question asked
    const big = await s.A.send(bytesSource(randomBytes(400_000, 3)));
    await until(() => s.offers.length === 1);
    expect(s.offers[0].id).toBe(big);
    expect(s.B.get(big)?.state).toBe('incoming');
    s.end();
  });

  it('an empty file', async () => {
    const s = setup();
    s.acceptAll();
    s.connect();
    let done = 0;
    s.B.on('done', () => done++);
    s.A.on('done', () => done++);
    await s.A.send(bytesSource(new Uint8Array(0), 'empty.txt'));
    await until(() => done === 2);
    expect(s.sinks[0].bytes().length).toBe(0);
    s.end();
  });

  it('decline', async () => {
    const s = setup();
    s.connect();
    s.B.on('offer', (t) => s.B.decline(t.id));
    const id = await s.A.send(bytesSource(randomBytes(500_000)));
    await until(() => s.A.get(id)?.state === 'declined');
    expect(s.B.get(id)?.state).toBe('declined');
    s.end();
  });

  it('cancel by the sender and by the receiver', async () => {
    const s = setup({}, { bytesPerTick: 64 * 1024 });
    const aborted: string[] = [];
    s.B.on('offer', (t) => {
      const sink = memorySink(t.size);
      const abort = sink.abort;
      sink.abort = async () => (aborted.push(t.id), abort());
      void s.B.accept(t.id, sink);
    });
    s.connect();
    const one = await s.A.send(bytesSource(randomBytes(4 * 1024 * 1024, 4)));
    await until(() => (s.B.get(one)?.bytes ?? 0) > 0);
    s.A.cancel(one);
    await until(() => s.B.get(one)?.state === 'cancelled');
    expect(s.A.get(one)?.state).toBe('cancelled');
    expect(aborted).toContain(one);

    const two = await s.A.send(bytesSource(randomBytes(4 * 1024 * 1024, 5)));
    await until(() => (s.B.get(two)?.bytes ?? 0) > 0);
    s.B.cancel(two);
    await until(() => s.A.get(two)?.state === 'cancelled');
    expect(s.A.get(two)?.error).toBe('they cancelled');
    s.end();
  });

  it('pause and resume (receiver side)', async () => {
    const s = setup({}, { bytesPerTick: 256 * 1024 });
    s.acceptAll();
    s.connect();
    const bytes = randomBytes(3 * 1024 * 1024, 6);
    const id = await s.A.send(bytesSource(bytes));
    await until(() => (s.B.get(id)?.bytes ?? 0) > 0);
    s.B.pause(id);
    await until(() => s.A.get(id)?.state === 'paused');
    await sleep(50);
    const at = s.B.get(id)!.bytes;
    await sleep(100);
    expect(s.B.get(id)!.bytes).toBe(at); // nothing more after the pieces in flight
    expect(s.B.get(id)!.state).toBe('paused');
    s.B.resume(id);
    await until(() => s.A.get(id)?.state === 'done');
    expect(toHex(sha256(s.sinks[0].bytes()))).toBe(toHex(sha256(bytes)));
    s.end();
  });
});

describe('files: breaks, resume and checks', () => {
  it('1 MB with random lost pieces: resumes and matches', async () => {
    const s = setup({}, { dropRate: 0.08, rng: rng(42) });
    s.acceptAll();
    s.connect();
    const bytes = randomBytes(1024 * 1024, 8);
    const id = await s.A.send(bytesSource(bytes));
    await until(() => s.A.get(id)?.state === 'done');
    expect(toHex(sha256(s.sinks[0].bytes()))).toBe(toHex(sha256(bytes)));
    s.end();
  });

  it('50 MB with random drops and disconnects: resumes where it was and matches', async () => {
    const r = rng(2026);
    const s = setup({}, { dropRate: 0.01, rng: r, bytesPerTick: 2 * 1024 * 1024 });
    s.acceptAll();
    s.connect();
    const bytes = randomBytes(50 * 1024 * 1024, 9);
    const id = await s.A.send(bytesSource(bytes, 'film.mp4', 'video/mp4'));
    const resumedFrom: number[] = [];
    let breaks = 0;
    while (s.A.get(id)?.state !== 'done') {
      await sleep(40 + Math.floor(r() * 80));
      const st = s.A.get(id)?.state;
      if (st === 'done' || st === 'failed') break;
      if (breaks < 6) {
        s.drop();
        breaks++;
        expect(s.A.get(id)?.state).toBe('waiting');
        await sleep(10);
        resumedFrom.push(s.B.get(id)!.bytes);
        s.connect();
      }
    }
    await until(() => s.A.get(id)?.state === 'done' && s.B.get(id)?.state === 'done', 60_000);
    expect(breaks).toBeGreaterThan(0);
    expect(resumedFrom.some((b) => b > 0)).toBe(true); // resumed in the middle, not from the start
    expect(toHex(sha256(s.sinks[0].bytes()))).toBe(toHex(sha256(bytes)));
    // Resuming re-sends at most the window in flight per break, not the whole file.
    const sent = s.data.reduce((n, d) => n + d.a.sentBytes, 0);
    expect(sent).toBeLessThan(bytes.length * 1.6);
    s.end();
  }, 120_000);

  it('a corrupted chunk is detected and sent again', async () => {
    let hits = 0;
    const s = setup(
      {},
      {
        mangle: (f) => {
          // Flip a byte in the first part of chunk 2, once.
          const index = new DataView(f.buffer, f.byteOffset).getUint32(10);
          if (index === 2 && hits === 0 && f.length > 100) {
            hits++;
            const g = f.slice();
            g[60] ^= 0xff;
            return g;
          }
          return f;
        },
      },
    );
    s.acceptAll();
    s.connect();
    const bad: number[] = [];
    s.B.on('corrupt', (_t, i) => bad.push(i));
    const bytes = randomBytes(1024 * 1024, 10);
    const id = await s.A.send(bytesSource(bytes));
    await until(() => s.A.get(id)?.state === 'done');
    expect(bad).toEqual([2]);
    expect(s.B.get(id)?.corrupt).toBe(1);
    expect(toHex(sha256(s.sinks[0].bytes()))).toBe(toHex(sha256(bytes)));
    s.end();
  });

  it('a chunk that keeps arriving damaged fails the transfer', async () => {
    const s = setup(
      { maxRetries: 2 },
      {
        mangle: (f) => {
          if (new DataView(f.buffer, f.byteOffset).getUint32(10) !== 1) return f;
          const g = f.slice();
          g[g.length - 1] ^= 1;
          return g;
        },
      },
    );
    s.acceptAll();
    s.connect();
    const id = await s.A.send(bytesSource(randomBytes(1024 * 1024, 11)));
    await until(() => s.A.get(id)?.state === 'cancelled' || s.A.get(id)?.state === 'failed');
    expect(s.B.get(id)?.state).toBe('failed');
    expect(s.B.get(id)?.corrupt).toBe(3);
    s.end();
  });

  it('a whole-file SHA-256 that does not match fails on both sides', async () => {
    const s = setup();
    s.acceptAll();
    s.connect();
    const bytes = randomBytes(600_000, 12);
    const id = await s.A.send(bytesSource(bytes), { sha256: toHex(sha256(randomBytes(10, 13))) });
    await until(() => s.A.get(id)?.state === 'failed');
    expect(s.B.get(id)?.state).toBe('failed');
    s.end();
  });

  it('back-pressure: the sender never queues much more than highWater on the data channel', async () => {
    const highWater = 512 * 1024;
    const s = setup({ highWater, lowWater: 128 * 1024, window: 64 }, { bytesPerTick: 32 * 1024 });
    s.acceptAll();
    s.connect();
    const bytes = randomBytes(6 * 1024 * 1024, 14);
    const id = await s.A.send(bytesSource(bytes));
    await until(() => s.A.get(id)?.state === 'done', 60_000);
    const maxQueued = Math.max(...s.data.map((d) => d.a.maxQueued));
    // At most one chunk (256 KB + headers) above the high-water mark.
    expect(maxQueued).toBeLessThanOrEqual(highWater + 262_144 + 1024);
    expect(maxQueued).toBeGreaterThan(highWater / 2); // it did fill the buffer
    expect(toHex(sha256(s.sinks[0].bytes()))).toBe(toHex(sha256(bytes)));
    s.end();
  }, 60_000);

  it('ignores a bad offer and frames for unknown transfers', async () => {
    const s = setup();
    s.connect();
    s.B.onFrame({ k: 'file-offer', v: 1, id: 'short', name: 'x', size: 10, mime: '', chunk: 262144, key: 'AAAA', ts: 0 });
    s.B.onFrame({ k: 'file-offer', v: 1, id: 'AAAAAAAAAAAA', name: 'x', size: -1, mime: '', chunk: 262144, key: 'A'.repeat(43), ts: 0 });
    s.B.onFrame(new Uint8Array([1, 2, 3]));
    s.B.onFrame({ k: 'file-hash', id: 'nope', sha256: '00' });
    await sleep(10);
    expect(s.B.list()).toEqual([]);
    expect(s.offers).toEqual([]);
    s.end();
  });
});

describe('files: many at once (BUG-9)', () => {
  const autoSetup = (opts: FileTransfersOptions = {}, optsB: FileTransfersOptions = {}) => {
    const sinks = new Map<string, MemorySink>();
    const s = setup(
      { autoAcceptBelow: 1024 * 1024, autoAcceptPerDay: 1e12, autoAcceptReserve: 0, freeSpace: async () => undefined, ...opts },
      {},
      { autoSink: async (t) => (sinks.set(t.id, memorySink(t.size)), sinks.get(t.id)!), ...optsB },
    );
    return { ...s, autoSinks: sinks };
  };

  it('200 small files picked at once: all 200 arrive, checked; none is cancelled', async () => {
    const s = autoSetup();
    s.connect();
    const states = new Map<string, Set<string>>();
    s.A.on('update', (t) => (states.get(t.id) ?? states.set(t.id, new Set()).get(t.id)!).add(t.state));
    let doneB = 0;
    s.B.on('done', () => doneB++);
    const files = Array.from({ length: 200 }, (_, i) => randomBytes(1024 + ((i * 7919) % (63 * 1024)), 100 + i));
    const ids: string[] = [];
    for (const f of files) ids.push(await s.A.send(bytesSource(f, `small-${i3(ids.length)}.bin`)));
    expect(s.A.list().filter((t) => t.state === 'queued').length).toBe(192); // 8 go at a time
    await until(() => doneB === 200, 60_000);
    await until(() => ids.every((id) => s.A.get(id)?.state === 'done'));
    ids.forEach((id, i) => expect(toHex(sha256(s.autoSinks.get(id)!.bytes()))).toBe(toHex(sha256(files[i]))));
    expect([...states.values()].some((x) => x.has('cancelled'))).toBe(false);
    s.end();
  }, 90_000);

  it('a receiver that takes fewer at once answers "busy": the sender waits and offers again', async () => {
    const s = autoSetup({}, { maxIncoming: 2 });
    s.connect();
    let doneB = 0;
    s.B.on('done', () => doneB++);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await s.A.send(bytesSource(randomBytes(5000, i), `f${i}.bin`)));
    await until(() => doneB === 20, 60_000);
    await until(() => ids.every((id) => s.A.get(id)?.state === 'done'));
    s.end();
  }, 90_000);

  it('files that need Accept: past the offers on screen they wait ("queued"), then go once accepted', async () => {
    const s = setup({ autoAcceptBelow: 0 });
    s.connect();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await s.A.send(bytesSource(randomBytes(3000, i), `big${i}.bin`)));
    await until(() => s.offers.length === 4); // the receiver shows at most 4 offers at once
    await sleep(100);
    expect(ids.filter((id) => s.A.get(id)?.state === 'cancelled')).toEqual([]);
    expect(ids.filter((id) => s.A.get(id)?.state === 'queued').length).toBe(2);
    s.acceptAll();
    for (const t of s.offers) void s.B.accept(t.id, memorySink(t.size));
    await until(() => ids.every((id) => s.A.get(id)?.state === 'done'), 60_000);
    s.end();
  }, 90_000);
});

const i3 = (n: number) => String(n).padStart(3, '0');
