// A tiny local Nostr relay for tests (NIP-01 REQ / EVENT / CLOSE / OK / EOSE).
//   - ephemeral kinds (20000–29999): forwarded to matching subscriptions, never stored;
//   - other kinds: stored (addressable 30000–39999 replaced per pubkey + "d"), sent to new REQs
//     that match (kinds, #t, since), and forwarded live;
//   - NIP-40: events with an "expiration" tag in the past are refused and dropped when they expire.
import { WebSocketServer, type WebSocket } from 'ws';

interface Filter {
  kinds?: number[];
  '#t'?: string[];
  since?: number;
}

interface Ev {
  id: string;
  kind: number;
  tags: string[][];
  content: string;
  pubkey: string;
  created_at: number;
}

export interface MockRelay {
  url: string;
  /** Every EVENT received, in order. */
  events: Ev[];
  /** Events currently stored (not expired). */
  stored(): Ev[];
  /** Event ids deleted by NIP-09 requests. */
  deleted: string[];
  close(): Promise<void>;
}

export async function startMockRelay(): Promise<MockRelay> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const subs = new Map<WebSocket, Map<string, Filter[]>>();
  const events: Ev[] = [];
  const deleted: string[] = [];
  let store: Ev[] = [];
  const expiry = (ev: Ev) => Number(ev.tags.find((t) => t[0] === 'expiration')?.[1] ?? Infinity);
  const live = () => {
    const now = Date.now() / 1000;
    store = store.filter((e) => expiry(e) > now);
    return store;
  };

  const matches = (f: Filter, ev: Ev) =>
    (!f.kinds || f.kinds.includes(ev.kind)) &&
    (!f['#t'] || ev.tags.some((t) => t[0] === 't' && f['#t']!.includes(t[1]))) &&
    (!f.since || ev.created_at >= f.since);

  wss.on('connection', (ws) => {
    subs.set(ws, new Map());
    ws.on('close', () => subs.delete(ws));
    ws.on('message', (data) => {
      let m: unknown[];
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (m[0] === 'REQ') {
        const filters = m.slice(2) as Filter[];
        subs.get(ws)!.set(String(m[1]), filters);
        for (const ev of live()) if (filters.some((f) => matches(f, ev))) ws.send(JSON.stringify(['EVENT', m[1], ev]));
        ws.send(JSON.stringify(['EOSE', m[1]]));
      } else if (m[0] === 'CLOSE') {
        subs.get(ws)!.delete(String(m[1]));
      } else if (m[0] === 'EVENT') {
        const ev = m[1] as Ev;
        events.push(ev);
        if (expiry(ev) <= Date.now() / 1000) {
          ws.send(JSON.stringify(['OK', ev.id, false, 'invalid: event has expired']));
          return;
        }
        ws.send(JSON.stringify(['OK', ev.id, true, '']));
        if (ev.kind === 5) {
          // NIP-09: drop the listed events, only if signed by the same key.
          const ids = new Set(ev.tags.filter((t) => t[0] === 'e').map((t) => t[1]));
          store = store.filter((e) => !(ids.has(e.id) && e.pubkey === ev.pubkey));
          deleted.push(...ids);
          return;
        }
        const ephemeral = ev.kind >= 20000 && ev.kind < 30000;
        if (!ephemeral) {
          const d = ev.tags.find((t) => t[0] === 'd')?.[1];
          if (ev.kind >= 30000 && ev.kind < 40000) store = store.filter((e) => !(e.kind === ev.kind && e.pubkey === ev.pubkey && e.tags.find((t) => t[0] === 'd')?.[1] === d));
          store.push(ev);
        }
        for (const [peer, list] of subs) {
          for (const [id, filters] of list) {
            if (filters.some((f) => matches(f, ev))) peer.send(JSON.stringify(['EVENT', id, ev]));
          }
        }
      }
    });
  });

  const port = (wss.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    events,
    deleted,
    stored: () => [...live()],
    close: () =>
      new Promise((r) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => r());
      }),
  };
}
