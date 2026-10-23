import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkWatch, RECONNECT_GIVE_UP_MS, RESTART_EVERY_MS, STALL_MS } from '../../src/net/peer';

// BUG-8: a short network stall must not end a call. LinkWatch turns ICE states into "restart",
// "reconnecting" / "up" and (only after ~20 s of trying) "give up".

function watch() {
  const log: string[] = [];
  const w = new LinkWatch({
    restart: (n) => log.push(`restart ${n}`),
    change: (s) => log.push(s),
    giveUp: () => log.push('give up'),
  });
  return { w, log };
}

describe('LinkWatch (ICE restart instead of "Call ended")', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a short "disconnected" that comes back by itself: reconnecting, then up, no restart', () => {
    const { w, log } = watch();
    w.ice('disconnected');
    vi.advanceTimersByTime(STALL_MS - 1000);
    w.ice('connected');
    vi.advanceTimersByTime(60_000);
    expect(log).toEqual(['reconnecting', 'up']);
  });

  it('"disconnected" for more than 5 s: an ICE restart; connected again: up', () => {
    const { w, log } = watch();
    w.ice('disconnected');
    vi.advanceTimersByTime(STALL_MS);
    expect(log).toEqual(['reconnecting', 'restart 1']);
    w.ice('checking');
    w.ice('connected');
    vi.advanceTimersByTime(60_000);
    expect(log).toEqual(['reconnecting', 'restart 1', 'up']);
    expect(w.state).toBe('up');
  });

  it('"failed": restarts at once, tries again every 5 s, and gives up after 20 s', () => {
    const { w, log } = watch();
    w.ice('failed');
    expect(log).toEqual(['reconnecting', 'restart 1']);
    vi.advanceTimersByTime(RESTART_EVERY_MS);
    expect(log.at(-1)).toBe('restart 2');
    vi.advanceTimersByTime(RECONNECT_GIVE_UP_MS - RESTART_EVERY_MS);
    expect(log.at(-1)).toBe('give up');
    expect(log.filter((x) => x.startsWith('restart')).length).toBe(RECONNECT_GIVE_UP_MS / RESTART_EVERY_MS);
    w.ice('connected'); // too late: it stays down
    expect(log.at(-1)).toBe('give up');
    expect(w.state).toBe('down');
  });

  it('"failed" while already waiting on a "disconnected": restarts at once (one "reconnecting")', () => {
    const { w, log } = watch();
    w.ice('disconnected');
    vi.advanceTimersByTime(1000);
    w.ice('failed');
    expect(log).toEqual(['reconnecting', 'restart 1']);
  });

  it('recovers several times in one connection, each time from the start', () => {
    const { w, log } = watch();
    for (let i = 0; i < 3; i++) {
      w.ice('failed');
      vi.advanceTimersByTime(RECONNECT_GIVE_UP_MS - 1000);
      w.ice('connected');
    }
    vi.advanceTimersByTime(60_000);
    expect(log.filter((x) => x === 'give up')).toEqual([]);
    expect(log.filter((x) => x === 'up').length).toBe(3);
  });

  it('closed or stopped: nothing more happens', () => {
    const { w, log } = watch();
    w.ice('disconnected');
    w.ice('closed');
    vi.advanceTimersByTime(60_000);
    w.ice('failed');
    expect(log).toEqual(['reconnecting']);
  });
});
