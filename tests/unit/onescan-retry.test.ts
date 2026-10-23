// "Show my code": when no relay answers, try once more (~2 s later, also the other built-in relays)
// before falling back to two-step codes. Seen once in test:real while two tests ran at the same time.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { identityFromPhrase, newPhrase } from '../../src/core/identity';
import { hostCard, RELAY_RETRY_MS } from '../../src/net/oneScan';

/** A WebSocket that fails for every URL in `down` (and for all of them in the first `failRounds` tries). */
function fakeSockets(down: Set<string>, failFirst: number) {
  const opened: string[] = [];
  let made = 0;
  class FakeWS {
    static OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    constructor(readonly url: string) {
      const fail = made++ < failFirst || down.has(url);
      setTimeout(() => {
        if (fail) {
          this.readyState = 3;
          this.onerror?.();
          this.onclose?.();
        } else {
          this.readyState = 1;
          opened.push(url);
          this.onopen?.();
        }
      }, 5);
    }
    send(): void {}
    close(): void {
      this.readyState = 3;
    }
  }
  vi.stubGlobal('WebSocket', FakeWS);
  return opened;
}

afterEach(() => vi.unstubAllGlobals());

describe('one scan: relay retry before two-step codes', () => {
  it('no relay answers at first: one retry ~2 s later works, also through the other relays', async () => {
    const mine = ['wss://a.example', 'wss://b.example'];
    const others = ['wss://c.example'];
    const opened = fakeSockets(new Set(mine), 0); // my chosen relays are down; another built-in one works
    const id = await identityFromPhrase(newPhrase());
    const t0 = Date.now();
    const hosted = await hostCard({ ...id, name: 'Asha' }, mine, () => undefined, others);
    expect(hosted).not.toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(RELAY_RETRY_MS);
    expect(hosted!.relays).toEqual(['wss://c.example']);
    expect(opened).toEqual(['wss://c.example']);
    hosted!.close();
  }, 20_000);

  it('a busy moment (every relay refuses once): the retry reaches them', async () => {
    const mine = ['wss://a.example', 'wss://b.example'];
    fakeSockets(new Set(), 2);
    const id = await identityFromPhrase(newPhrase());
    const hosted = await hostCard({ ...id, name: 'Asha' }, mine, () => undefined);
    expect(hosted?.relays.sort()).toEqual(mine);
    hosted!.close();
  }, 20_000);

  it('still nothing after the retry: null (the screen then offers two-step codes)', async () => {
    fakeSockets(new Set(['wss://a.example']), 0);
    const id = await identityFromPhrase(newPhrase());
    expect(await hostCard({ ...id, name: 'Asha' }, ['wss://a.example'], () => undefined)).toBeNull();
  }, 20_000);
});
