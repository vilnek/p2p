// Test lab relay: the same NIP-01 / NIP-09 / NIP-40 behaviour as tests/e2e/mock-relay.ts, plus fault
// switches the lab needs:
//   - a fixed port, so it can be killed and started again at the same address (stop() / start());
//   - delayMs: every reply (OK, EVENT, EOSE) is held back this long (a slow relay);
//   - since filtering uses the relay's own clock-free rule (created_at >= since), like real relays;
//   - maxFutureS: refuse events whose created_at is too far ahead of the relay's clock (some real
//     relays do this; 0 = off).
import { WebSocketServer, type WebSocket } from 'ws';

interface Filter {
  kinds?: number[];
  '#t'?: string[];
  since?: number;
}
export interface Ev {
  id: string;
  kind: number;
  tags: string[][];
  content: string;
  pubkey: string;
  created_at: number;
}

export class LabRelay {
  wss: WebSocketServer | null = null;
  port = 0;
  delayMs = 0;
  maxFutureS = 0;
  events: Ev[] = [];
  connections = 0;
  private store: Ev[] = [];
  private subs = new Map<WebSocket, Map<string, Filter[]>>();

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  private expiry = (ev: Ev) => Number(ev.tags.find((t) => t[0] === 'expiration')?.[1] ?? Infinity);
  private live(): Ev[] {
    const now = Date.now() / 1000;
    this.store = this.store.filter((e) => this.expiry(e) > now);
    return this.store;
  }
  private matches = (f: Filter, ev: Ev) =>
    (!f.kinds || f.kinds.includes(ev.kind)) && (!f['#t'] || ev.tags.some((t) => t[0] === 't' && f['#t']!.includes(t[1]))) && (!f.since || ev.created_at >= f.since);

  private send(ws: WebSocket, msg: unknown): void {
    const go = () => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    if (this.delayMs) setTimeout(go, this.delayMs);
    else go();
  }

  /** Starts (or starts again) on the same port. keepStore=false forgets stored events (a fresh relay). */
  async start(keepStore = true): Promise<void> {
    if (!keepStore) this.store = [];
    const wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });
    await new Promise<void>((r, j) => {
      wss.once('listening', () => r());
      wss.once('error', j);
    });
    this.wss = wss;
    this.port = (wss.address() as { port: number }).port;
    wss.on('connection', (ws) => {
      this.connections++;
      this.subs.set(ws, new Map());
      ws.on('close', () => this.subs.delete(ws));
      ws.on('message', (data) => this.onMessage(ws, data));
    });
  }

  /** Kills the relay: every socket is cut at once (no close handshake), the port is freed. */
  async stop(): Promise<void> {
    const wss = this.wss;
    if (!wss) return;
    this.wss = null;
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  }

  /** Cuts every open socket but keeps listening (a relay restart that is quick). */
  dropSockets(): void {
    for (const ws of this.wss?.clients ?? []) ws.terminate();
  }

  private onMessage(ws: WebSocket, data: unknown): void {
    let m: unknown[];
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (m[0] === 'REQ') {
      const filters = m.slice(2) as Filter[];
      this.subs.get(ws)?.set(String(m[1]), filters);
      for (const ev of this.live()) if (filters.some((f) => this.matches(f, ev))) this.send(ws, ['EVENT', m[1], ev]);
      this.send(ws, ['EOSE', m[1]]);
    } else if (m[0] === 'CLOSE') {
      this.subs.get(ws)?.delete(String(m[1]));
    } else if (m[0] === 'EVENT') {
      const ev = m[1] as Ev;
      this.events.push(ev);
      if (this.expiry(ev) <= Date.now() / 1000) return this.send(ws, ['OK', ev.id, false, 'invalid: event has expired']);
      if (this.maxFutureS && ev.created_at > Date.now() / 1000 + this.maxFutureS) return this.send(ws, ['OK', ev.id, false, 'invalid: created_at too far in the future']);
      this.send(ws, ['OK', ev.id, true, '']);
      if (ev.kind === 5) {
        const ids = new Set(ev.tags.filter((t) => t[0] === 'e').map((t) => t[1]));
        this.store = this.store.filter((e) => !(ids.has(e.id) && e.pubkey === ev.pubkey));
        return;
      }
      if (!(ev.kind >= 20000 && ev.kind < 30000)) {
        const d = ev.tags.find((t) => t[0] === 'd')?.[1];
        if (ev.kind >= 30000 && ev.kind < 40000) this.store = this.store.filter((e) => !(e.kind === ev.kind && e.pubkey === ev.pubkey && e.tags.find((t) => t[0] === 'd')?.[1] === d));
        this.store.push(ev);
      }
      for (const [peer, list] of this.subs) for (const [id, filters] of list) if (filters.some((f) => this.matches(f, ev))) this.send(peer, ['EVENT', id, ev]);
    }
  }
}

export async function startLabRelay(port = 0): Promise<LabRelay> {
  const r = new LabRelay();
  r.port = port;
  await r.start();
  return r;
}
