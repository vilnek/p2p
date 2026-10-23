// Security review (23 Oct 2026, second pass), M-7 follow-up: a relay, or anyone who knows a tag, can
// stream events at the page. RelayPool must (1) keep its "seen" memory bounded, (2) hand the app at
// most a fixed number of events per relay per window, and (3) never throw on a malformed event.
import { describe, expect, it } from 'vitest';
import { RelayPool, SIGNAL_KIND, type NostrEvent } from '../../src/net/relay';

type Inner = { onMessage(data: unknown, rate?: { n: number; at: number }): void; subs: Map<string, unknown>; seen: Set<string> };

function pool(fn: (content: string) => void) {
  const p = new RelayPool([]);
  p.subscribe({ kinds: [SIGNAL_KIND], tags: ['t1'] }, fn);
  const inner = p as unknown as Inner;
  const subId = inner.subs.keys().next().value as string;
  const event = (content: string, patch: Partial<NostrEvent> | Record<string, unknown> = {}) =>
    JSON.stringify(['EVENT', subId, { id: 'x', pubkey: 'p', created_at: 1, kind: SIGNAL_KIND, tags: [['t', 't1']], content, sig: 's', ...patch }]);
  return { p, inner, event };
}

describe('relay pool: floods from a relay', () => {
  it('the seen set stays bounded, and big contents are kept as hashes', () => {
    let got = 0;
    const { inner, event } = pool(() => got++);
    const big = 'A'.repeat(100_000);
    for (let i = 0; i < 4500; i++) inner.onMessage(event(big + i));
    expect(got).toBe(4500);
    expect(inner.seen.size).toBeLessThanOrEqual(4000);
    for (const k of inner.seen) expect(k.length).toBeLessThanOrEqual(128);
  });

  it('the same content from several relays (or resent) is still handed over once', () => {
    let got = 0;
    const { inner, event } = pool(() => got++);
    inner.onMessage(event('same'));
    inner.onMessage(event('same', { id: 'y' }));
    inner.onMessage(event('B'.repeat(50_000)));
    inner.onMessage(event('B'.repeat(50_000)));
    expect(got).toBe(2);
  });

  it('one relay socket gets at most 300 events through per 10 s window', () => {
    let got = 0;
    const { inner, event } = pool(() => got++);
    const rate = { n: 0, at: 0 };
    for (let i = 0; i < 1000; i++) inner.onMessage(event(`c${i}`), rate);
    expect(got).toBe(300);
    // A new window: events flow again.
    rate.at = Date.now() - 11_000;
    inner.onMessage(event('later'), rate);
    expect(got).toBe(301);
  });

  it('malformed events are dropped without throwing', () => {
    let got = 0;
    const { inner, event } = pool(() => got++);
    const bad = [
      event('a', { tags: 'nope' as unknown as string[][] }),
      event('b', { tags: [null, 5, 'x', ['t']] as unknown as string[][] }),
      event('c', { kind: '25050' as unknown as number }),
      event('d', { tags: [['t', 't1']], content: 7 as unknown as string }),
      JSON.stringify(['EVENT', 'nosuchsub', { kind: SIGNAL_KIND, tags: [['t', 't1']], content: 'e' }]),
      JSON.stringify(['EVENT']),
      '{"not":"an array"}',
      'not json',
      event('f', { tags: [['t', 't1'], ['expiration', '1']] }), // expired
    ];
    for (const b of bad) expect(() => inner.onMessage(b)).not.toThrow();
    expect(got).toBe(0);
    inner.onMessage(event('ok'));
    expect(got).toBe(1);
  });
});
