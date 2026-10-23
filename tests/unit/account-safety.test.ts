import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { toHex, utf8 } from '../../src/core/bytes';
import { REPORT_DONE_TEXT, reportBody, reportDate, reportMailto } from '../../src/core/report';
import { deleteAccount, deleteFromRelays, DELETE_TEXT, wipeDevice, type DeletePool, type WipeEnv } from '../../src/core/wipe';
import { deletionEvent, RelayPool, type NostrEvent, type PublishedRecord } from '../../src/net/relay';
import { startMockRelay, type MockRelay } from '../e2e/mock-relay';

const THEM = '395064155608899644355146';
const ME = '123456789012345678901234';
const WHEN = Date.UTC(2026, 9, 23, 14, 5);

/** Splits a mailto: link the way a mail app does. */
function parseMailto(url: string) {
  const [to, query] = url.slice('mailto:'.length).split('?');
  const params: Record<string, string> = {};
  for (const part of query.split('&')) {
    const [k, v] = part.split('=');
    params[k] = decodeURIComponent(v);
  }
  return { to, query, ...params };
}

describe('Report: the email', () => {
  it('goes to info@vilnek.in with the subject "P2P Talk report"', () => {
    const m = parseMailto(reportMailto({ theirId: THEM, theirName: 'Ravi', myId: ME, when: WHEN }));
    expect(m.to).toBe('info@vilnek.in');
    expect(m.subject).toBe('P2P Talk report');
  });

  it('carries their P2P ID and name, my P2P ID and the date', () => {
    const body = parseMailto(reportMailto({ theirId: THEM, theirName: 'Ravi', myId: ME, when: WHEN })).body;
    expect(body).toContain('Their P2P ID: 395064155608899644355146'); // plain digits: easy to search and paste
    expect(body).toContain('Their name: Ravi');
    expect(body).toContain('My P2P ID: 123456789012345678901234');
    expect(body).toContain('Date: 2026-10-23 14:05 UTC');
    expect(body).toContain('(You can attach screenshots.)');
    expect(body).not.toContain('In the group');
  });

  it('names the group when a member is reported, and copes with no name', () => {
    const body = reportBody({ theirId: THEM, myId: ME, when: WHEN, group: 'Family' });
    expect(body).toContain('Their name: (no name)');
    expect(body).toContain('In the group: Family');
  });

  it('encodes every special character, so names cannot add fields or recipients', () => {
    const url = reportMailto({ theirId: THEM, theirName: 'A&cc=x@evil.test?bcc=y #1 + “quotes” नमस्ते', myId: ME, when: WHEN });
    const query = url.split('?').slice(1).join('?');
    expect(query.split('&').map((p) => p.split('=')[0])).toEqual(['subject', 'body']);
    expect(url).not.toMatch(/[ \n#]/);
    expect(url).not.toContain('+'); // a space is %20, never "+" (some mail apps show "+" as is)
    expect(parseMailto(url).body).toContain('Their name: A&cc=x@evil.test?bcc=y #1 + “quotes” नमस्ते');
  });

  it('a bare P2P ID (older callers) still works', () => {
    expect(parseMailto(reportMailto(THEM)).body).toContain(`I want to report this P2P ID: ${THEM}`);
  });

  it('the date is the same on every device (UTC) and the after-text is as agreed', () => {
    expect(reportDate(0)).toBe('1970-01-01 00:00 UTC');
    expect(REPORT_DONE_TEXT).toBe('Blocked. You can also email us the details.');
  });
});

// ---- Delete my account and data: the relays -------------------------------------------------------

function record(what: PublishedRecord['what'], relays: string[], exp = Math.floor(WHEN / 1000) + 3600): PublishedRecord {
  const secret = schnorr.utils.randomPrivateKey();
  return { secret: toHex(secret), id: toHex(crypto.getRandomValues(new Uint8Array(32))), kind: 30078, d: toHex(crypto.getRandomValues(new Uint8Array(8))), relays, exp, what };
}

class FakePool implements DeletePool {
  static made: FakePool[] = [];
  sent: NostrEvent[] = [];
  closed = false;
  constructor(
    readonly urls: string[],
    readonly reachable = true,
  ) {
    FakePool.made.push(this);
  }
  async connect() {
    return this.reachable ? this.urls : [];
  }
  async send(ev: NostrEvent) {
    this.sent.push(ev);
    return this.urls.length;
  }
  close() {
    this.closed = true;
  }
}

describe('Delete my account and data: the relays (NIP-09)', () => {
  it('builds a kind-5 deletion signed by the key that stored the event', () => {
    const r = record('card', ['wss://a']);
    const ev = deletionEvent(r, WHEN);
    const pub = toHex(schnorr.getPublicKey(Uint8Array.from(r.secret.match(/../g)!.map((x) => parseInt(x, 16)))));
    expect(ev.kind).toBe(5);
    expect(ev.pubkey).toBe(pub);
    expect(ev.created_at).toBe(Math.floor(WHEN / 1000));
    expect(ev.content).toBe('');
    expect(ev.tags).toEqual([['e', r.id], ['a', `30078:${pub}:${r.d}`], ['k', '30078']]);
    expect(ev.id).toBe(toHex(sha256(utf8(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])))));
    expect(schnorr.verify(ev.sig, ev.id, ev.pubkey)).toBe(true);
  });

  it('asks each relay group once, skips expired, repeated and not-allowed ones, and closes every pool', async () => {
    FakePool.made = [];
    const card = record('card', ['wss://a', 'wss://b']);
    const req = record('request', ['wss://b', 'wss://a']); // same relays, other order: same pool
    const reply = record('reply', ['wss://c']);
    const old = record('reply', ['wss://a'], Math.floor(WHEN / 1000) - 1);
    const outside = record('reply', ['wss://not-allowed']);
    const res = await deleteFromRelays([card, req, card, reply, old, outside], {
      now: WHEN,
      allowed: ['wss://a', 'wss://b', 'wss://c'],
      pool: (urls) => new FakePool(urls),
    });
    expect(res).toEqual({ asked: 3, ok: 2 + 2 + 1 });
    expect(FakePool.made.map((p) => p.urls)).toEqual([['wss://a', 'wss://b'], ['wss://c']]);
    expect(FakePool.made[0].sent.map((e) => e.tags[0][1])).toEqual([card.id, req.id]);
    expect(FakePool.made[1].sent.map((e) => e.tags[0][1])).toEqual([reply.id]);
    expect(FakePool.made.every((p) => p.closed)).toBe(true);
  });

  it('never throws when the relays cannot be reached', async () => {
    FakePool.made = [];
    const res = await deleteFromRelays([record('card', ['wss://a'])], { now: WHEN, pool: (u) => new FakePool(u, false) });
    expect(res).toEqual({ asked: 1, ok: 0 });
    expect(FakePool.made[0].closed).toBe(true);
  });

  it('sends all deletions at once (one wait for all, not one per event)', async () => {
    let inFlight = 0;
    let most = 0;
    const waits: number[] = [];
    const silent: DeletePool = {
      connect: async () => ['wss://a'],
      send: (_ev, waitMs) =>
        new Promise((r) => {
          inFlight++;
          most = Math.max(most, inFlight);
          waits.push(waitMs);
          setTimeout(() => (inFlight--, r(0)), 20); // a relay that never says OK
        }),
      close() {},
    };
    const records = Array.from({ length: 40 }, () => record('reply', ['wss://a']));
    await deleteFromRelays(records, { now: WHEN, pool: () => silent });
    expect(most).toBe(40); // all 40 in flight together
    expect(new Set(waits)).toEqual(new Set([3000])); // each waits at most ~3 s, at the same time
  }, 30_000);
});

describe('Delete my account and data: with a real relay', () => {
  let relay: MockRelay;
  beforeAll(async () => {
    relay = await startMockRelay();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = WsClient;
  });
  afterAll(async () => relay.close());

  it('the public card and an invite request are deleted from the relay', async () => {
    const records: PublishedRecord[] = [];
    RelayPool.onStored = (r) => records.push(r);
    const a = new RelayPool([relay.url]);
    await a.connect(2000);
    await a.store('aa'.repeat(32), 'card', Date.now() + 3600_000, 1, 5000, 'card');
    await a.store('bb'.repeat(32), 'request', Date.now() + 3600_000, 1, 5000, 'request');
    a.close();
    RelayPool.onStored = null;
    expect(relay.stored()).toHaveLength(2);
    const res = await deleteFromRelays(records, { allowed: [relay.url] });
    expect(res).toEqual({ asked: 2, ok: 2 });
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.stored()).toHaveLength(0);
    expect(relay.deleted.sort()).toEqual(records.map((r) => r.id).sort());
  });
});

// ---- Delete my account and data: this device ------------------------------------------------------

class FakeStorage {
  m = new Map<string, string>();
  constructor(init: Record<string, string>) {
    for (const [k, v] of Object.entries(init)) this.m.set(k, v);
  }
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

function fakeIdb(names: string[], withList = true) {
  const dbs = new Set(names);
  const idb = {
    dbs,
    deleteDatabase(name: string) {
      const req = { onsuccess: null as null | (() => void), onerror: null, onblocked: null };
      setTimeout(() => {
        dbs.delete(name);
        req.onsuccess?.();
      }, 1);
      return req;
    },
    ...(withList ? { databases: async () => [...dbs].map((name) => ({ name })) } : {}),
  };
  return idb;
}

function fakeOpfs(entries: string[]) {
  const root = new Set(entries);
  return {
    root,
    get: async () => ({
      async removeEntry(name: string, o?: { recursive?: boolean }) {
        if (!root.has(name)) throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
        if (!o?.recursive) throw new Error('needs recursive');
        root.delete(name);
      },
    }),
  };
}

describe('Delete my account and data: this device', () => {
  it('empties every store the app uses, and leaves other sites’ data alone', async () => {
    const idb = fakeIdb(['p2ptalk', 'p2ptalk-embed-0123456789abcdef', 'p2ptalk-embed-fedcba9876543210', 'someone-else']);
    const local = new FakeStorage({ 'p2p-last-name': 'Ravi', 'p2ptalk-embed-last': 'p2ptalk-embed-0123', theme: 'dark' });
    const session = new FakeStorage({ 'p2p-pending-link': 'https://p2p.vilnek.in/#c=x', other: '1' });
    const opfs = fakeOpfs(['p2p-files', 'other-dir']);
    let closed = 0;
    let native = 0;
    const env: WipeEnv = { idb, local, session, opfs: opfs.get, closeOpen: async () => void closed++, nativeFiles: async () => void native++ };
    const res = await wipeDevice(env);
    expect(closed).toBe(1);
    expect(native).toBe(1);
    expect([...idb.dbs]).toEqual(['someone-else']);
    expect(res.databases.sort()).toEqual(['p2ptalk', 'p2ptalk-embed-0123456789abcdef', 'p2ptalk-embed-fedcba9876543210']);
    expect([...local.m.keys()]).toEqual(['theme']);
    expect([...session.m.keys()]).toEqual(['other']);
    expect([...opfs.root]).toEqual(['other-dir']);
    expect(res.files).toBe(true);
    expect(res.keys.sort()).toEqual(['p2p-last-name', 'p2p-pending-link', 'p2ptalk-embed-last']);
  });

  it('still deletes the app database where the browser cannot list databases, and with no files', async () => {
    const idb = fakeIdb(['p2ptalk'], false);
    const opfs = fakeOpfs([]);
    const res = await wipeDevice({ idb, opfs: opfs.get });
    expect(res.databases).toEqual(['p2ptalk']);
    expect(idb.dbs.size).toBe(0);
    expect(res.files).toBe(true); // nothing was there
  });

  it('never throws when storage is blocked', async () => {
    const throwing = { get length(): number { throw new Error('blocked'); }, key: () => null, removeItem() {} };
    const res = await wipeDevice({
      idb: { deleteDatabase() { throw new Error('blocked'); } },
      local: throwing as unknown as FakeStorage,
      opfs: async () => { throw new Error('no OPFS'); },
      closeOpen: async () => { throw new Error('closed'); },
    }).catch((e: Error) => e);
    expect(res).not.toBeInstanceOf(Error);
  });

  it('deleteAccount asks the relays first, then wipes', async () => {
    const order: string[] = [];
    const pool = (urls: string[]): DeletePool => ({
      connect: async () => urls,
      send: async () => (order.push('relay'), 1),
      close() {},
    });
    const res = await deleteAccount([record('card', ['wss://a'], Math.floor(Date.now() / 1000) + 600)], {
      pool,
      env: { closeOpen: async () => void order.push('wipe') },
    });
    expect(order).toEqual(['relay', 'wipe']);
    expect(res.asked).toBe(1);
    expect(res.ok).toBe(1);
  });

  it('the confirm text is as agreed', () => {
    expect(DELETE_TEXT).toBe('This erases your keys, chats, contacts and files from this device and removes your public card. Other devices with the same 24 words keep their copy. This can’t be undone.');
  });
});
