// In-memory Channel pairs for unit tests: asynchronous delivery, a simulated send buffer
// (bufferedAmount) drained at a set speed, random drops, corruption and disconnects.

import type { Channel, Frame } from '../../src/core/channel';

export interface MemOptions {
  /** Bytes delivered per tick (setImmediate). Default 4 MB. */
  bytesPerTick?: number;
  /** Probability that a binary frame is lost (a broken link, simulated per frame). */
  dropRate?: number;
  /** Change a binary frame on the way (return it changed), or leave it (return it as is). */
  mangle?: (f: Uint8Array) => Uint8Array;
  rng?: () => number;
}

/** Seeded random numbers (mulberry32), so failures can be replayed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const size = (f: Frame) => (f instanceof Uint8Array ? f.length : JSON.stringify(f).length);

class End implements Channel {
  other!: End;
  queue: Frame[] = [];
  queued = 0;
  maxQueued = 0;
  closed = false;
  sentBytes = 0;
  private listeners = new Set<(f: Frame) => void>();
  private pumping = false;

  constructor(
    readonly peerId: string,
    private readonly o: Required<Omit<MemOptions, 'mangle'>> & Pick<MemOptions, 'mangle'>,
  ) {}

  async send(frame: Frame): Promise<void> {
    if (this.closed) throw new Error('channel closed');
    // Frames cross a wire: JSON objects as JSON text, bytes as a copy.
    const f = frame instanceof Uint8Array ? frame.slice() : JSON.parse(JSON.stringify(frame));
    this.queue.push(f);
    this.queued += size(f);
    this.sentBytes += size(f);
    this.maxQueued = Math.max(this.maxQueued, this.queued);
    this.pump();
  }

  onFrame(cb: (f: Frame) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  bufferedAmount = () => this.queued;

  close(): void {
    this.closed = true;
    this.queue = [];
    this.queued = 0;
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    setImmediate(() => {
      this.pumping = false;
      let budget = this.o.bytesPerTick;
      while (this.queue.length && budget > 0 && !this.closed) {
        let f = this.queue.shift()!;
        const n = size(f);
        this.queued -= n;
        budget -= n;
        if (this.other.closed) continue;
        if (f instanceof Uint8Array) {
          if (this.o.dropRate && this.o.rng() < this.o.dropRate) continue;
          if (this.o.mangle) f = this.o.mangle(f);
        }
        for (const cb of [...this.other.listeners]) cb(f);
      }
      if (this.queue.length && !this.closed) this.pump();
    });
  }
}

export interface MemPair {
  /** The end used by the first side (its peerId is the second side's ID). */
  a: End;
  b: End;
  close(): void;
}

/** A connected pair: `a` belongs to the side whose contact is `bId`, and the other way round. */
export function memPair(bId: string, aId: string, opts: MemOptions = {}): MemPair {
  const o = { bytesPerTick: 4 * 1024 * 1024, dropRate: 0, rng: Math.random, ...opts };
  const a = new End(bId, o);
  const b = new End(aId, o);
  a.other = b;
  b.other = a;
  return {
    a,
    b,
    close() {
      a.close();
      b.close();
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean, timeoutMs = 20_000, stepMs = 5): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(stepMs);
  }
}
