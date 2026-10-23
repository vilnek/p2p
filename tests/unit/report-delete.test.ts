import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { reportMailto } from '../../src/core/report';
import { RelayPool, type PublishedRecord } from '../../src/net/relay';
import { startMockRelay, type MockRelay } from '../e2e/mock-relay';

describe('Report', () => {
  it('opens the person’s own email app to info@vilnek.in with the subject and their P2P ID', () => {
    const url = reportMailto('395064155608899644355146');
    expect(url.startsWith('mailto:info@vilnek.in?subject=P2P%20Talk%20report&body=')).toBe(true);
    expect(decodeURIComponent(url.split('body=')[1])).toContain('I want to report this P2P ID: 395064155608899644355146');
  });
});

describe('Delete my account and data: relays are asked to delete what this device stored (NIP-09)', () => {
  let relay: MockRelay;
  beforeAll(async () => {
    relay = await startMockRelay();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = WsClient;
  });
  afterAll(async () => relay.close());

  it('each deletion is signed by the key that stored the event, and the relay drops it', async () => {
    const records: PublishedRecord[] = [];
    RelayPool.onStored = (r) => records.push(r);
    const a = new RelayPool([relay.url]);
    const b = new RelayPool([relay.url]); // another throwaway key
    await Promise.all([a.connect(2000), b.connect(2000)]);
    await a.store('aa'.repeat(32), 'card', Date.now() + 3600_000, 1, 5000, 'card');
    await b.store('bb'.repeat(32), 'request', Date.now() + 3600_000, 1, 5000, 'request');
    expect(relay.stored()).toHaveLength(2);
    expect(records.map((r) => r.what)).toEqual(['card', 'request']);

    // A later page (a new pool, its own throwaway key) can still delete them.
    const c = new RelayPool([relay.url]);
    await c.connect(2000);
    expect(await c.deleteStored(records)).toBe(2);
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.stored()).toHaveLength(0);
    expect(relay.deleted.sort()).toEqual(records.map((r) => r.id).sort());
    const dels = relay.events.filter((e) => e.kind === 5);
    expect(dels).toHaveLength(2);
    for (const [i, d] of dels.entries()) {
      expect(d.tags).toEqual(expect.arrayContaining([['e', records[i].id], ['k', '30078']]));
      expect(d.pubkey).toBe(relay.events.find((e) => e.id === records[i].id)!.pubkey);
    }
    // A deletion signed by someone else is ignored.
    const forged = { ...records[0], secret: '11'.repeat(32) };
    await a.store('cc'.repeat(32), 'again', Date.now() + 3600_000, 1, 5000, 'card');
    const kept = relay.stored()[0].id;
    await c.deleteStored([{ ...forged, id: kept }]);
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.stored().map((e) => e.id)).toEqual([kept]);
    for (const p of [a, b, c]) p.close();
    RelayPool.onStored = null;
  });
});
