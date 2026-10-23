// A tiny client for public Nostr relays (NIP-01: REQ / EVENT / CLOSE / OK / EOSE).
// Used only to pass small locked connection messages:
//   - ephemeral events (kind 25050, 20000–29999): live connection offers/answers, never stored;
//   - stored events (kind 30078, NIP-78 app data) with a NIP-40 "expiration" tag: invite requests
//     and acceptances that must wait for someone who is offline. Relays drop them at expiry.
// Each pool signs with a throwaway key that is not linked to the user's identity.

import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { toHex, utf8 } from '../core/bytes';

/** Ephemeral kind used for live WebRTC signalling. */
export const SIGNAL_KIND = 25050;
/** Stored kind (NIP-78 application data) for invite requests and acceptances. */
export const STORED_KIND = 30078;
/** Stored events never live longer than this past "now" (NIP-40 expiration). */
export const MAX_STORE_S = 24 * 3600;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface Filter {
  kinds: number[];
  tags: string[];
  since?: number;
}

/** NIP-09 deletion request. */
export const DELETE_KIND = 5;

/** A stored event this device put on the relays, kept so it can ask for its deletion later (NIP-09). */
export interface PublishedRecord {
  /** The throwaway Nostr key that signed it (hex); a deletion must be signed by the same key. */
  secret: string;
  id: string;
  kind: number;
  d: string;
  relays: string[];
  /** NIP-40 expiry (seconds): after this the relays drop it anyway. */
  exp: number;
  what: 'card' | 'request' | 'reply';
}

export function makeEvent(secret: Uint8Array, tag: string, content: string, now = Date.now(), kind = SIGNAL_KIND, extra: string[][] = []): NostrEvent {
  const pubkey = toHex(schnorr.getPublicKey(secret));
  const created_at = Math.floor(now / 1000);
  const tags = [['t', tag], ...extra];
  const id = toHex(sha256(utf8(JSON.stringify([0, pubkey, created_at, kind, tags, content]))));
  const sig = toHex(schnorr.sign(id, secret));
  return { id, pubkey, created_at, kind, tags, content, sig };
}

/**
 * NIP-09 deletion request for one stored event: kind 5, tags e (event id), a (kind:pubkey:d) and k
 * (kind), signed by the same throwaway key that stored it (relays ignore a deletion from another key).
 */
export function deletionEvent(r: PublishedRecord, now = Date.now()): NostrEvent {
  const secret = Uint8Array.from(r.secret.match(/../g)!.map((x) => parseInt(x, 16)));
  const pubkey = toHex(schnorr.getPublicKey(secret));
  const created_at = Math.floor(now / 1000);
  const tags = [['e', r.id], ['a', `${r.kind}:${pubkey}:${r.d}`], ['k', String(r.kind)]];
  const id = toHex(sha256(utf8(JSON.stringify([0, pubkey, created_at, DELETE_KIND, tags, '']))));
  return { id, pubkey, created_at, kind: DELETE_KIND, tags, content: '', sig: toHex(schnorr.sign(id, secret)) };
}

/** Messages already handled (security review M-7): bounded, the oldest forgotten first. */
const SEEN_MAX = 4000;
/** A relay (or a flood on a tag) may hand the page at most this many events per window; the rest are dropped. */
const RATE_MAX_EVENTS = 300;
const RATE_WINDOW_MS = 10_000;

/** A short key for `seen`: the content itself when small, else its hash (so a flood can't fill memory). */
const seenKey = (content: string) => (content.length <= 128 ? content : toHex(sha256(utf8(content))));

export class RelayPool {
  private sockets = new Map<string, WebSocket>();
  private all: WebSocket[] = [];
  private subs = new Map<string, { filter: Filter; fn: (content: string, ev: NostrEvent) => void }>();
  private oks = new Map<string, (ok: boolean) => void>();
  private seen = new Set<string>();
  private readonly secret = schnorr.utils.randomPrivateKey();
  private closed = false;
  /** Set by the app: told about every stored event this pool put on the relays. */
  static onStored: ((r: PublishedRecord) => void) | null = null;

  constructor(readonly urls: string[]) {}

  /** Connects to every relay. Resolves with the ones that opened (shortly after the first, or at the time limit). */
  connect(limitMs = 6000): Promise<string[]> {
    return new Promise((resolve) => {
      let pending = this.urls.length;
      let grace: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        clearTimeout(limit);
        if (grace) clearTimeout(grace);
        resolve(this.open());
      };
      const limit = setTimeout(done, limitMs);
      const settle = () => {
        if (--pending <= 0) done();
        else if (this.open().length && !grace) grace = setTimeout(done, 1500);
      };
      if (!pending) return done();
      for (const url of this.urls) this.openSocket(url, settle);
    });
  }

  /** Reconnect delays after a relay socket closes (then every 30 s while the pool is open). */
  private static readonly BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
  private retries = new Map<string, number>();

  /**
   * Opens one relay socket. If it closes later (a relay restart, a network blip), it comes back by
   * itself with growing waits, and every subscription is asked again: long-lived listeners (a shown
   * code, invites, pending replies, the ID box) don't go deaf.
   */
  private openSocket(url: string, settle?: () => void): void {
    let settled = false;
    const once = () => {
      if (!settled) {
        settled = true;
        settle?.();
      }
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      once();
      return;
    }
    this.all.push(ws);
    let opened = false;
    ws.onopen = () => {
      if (this.closed) return ws.close();
      opened = true;
      this.retries.delete(url);
      this.sockets.set(url, ws);
      for (const [id, s] of this.subs) this.req(ws, id, s.filter);
      once();
    };
    ws.onerror = once;
    ws.onclose = () => {
      if (this.sockets.get(url) === ws) this.sockets.delete(url);
      this.all = this.all.filter((x) => x !== ws);
      once();
      if (this.closed || (!opened && !settle && !this.retries.has(url))) return;
      // It worked before (or we are already retrying): try again later.
      const n = this.retries.get(url) ?? 0;
      this.retries.set(url, n + 1);
      const wait = RelayPool.BACKOFF_MS[Math.min(n, RelayPool.BACKOFF_MS.length - 1)];
      setTimeout(() => !this.closed && !this.sockets.has(url) && this.openSocket(url), wait);
    };
    const rate = { n: 0, at: 0 };
    ws.onmessage = (e) => this.onMessage(e.data, rate);
  }

  open(): string[] {
    return [...this.sockets].filter(([, ws]) => ws.readyState === WebSocket.OPEN).map(([u]) => u);
  }

  private req(ws: WebSocket, id: string, f: Filter): void {
    const filter: Record<string, unknown> = { kinds: f.kinds, '#t': f.tags };
    if (f.since) filter.since = f.since;
    ws.send(JSON.stringify(['REQ', id, filter]));
  }

  /** `rate`: this socket's event count in the current window (one relay can't flood the page). */
  private onMessage(data: unknown, rate?: { n: number; at: number }): void {
    if (typeof data !== 'string' || data.length > 200_000) return;
    let m: unknown;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(m)) return;
    if (m[0] === 'OK') {
      this.oks.get(String(m[1]))?.(m[2] === true);
      return;
    }
    if (m[0] !== 'EVENT') return;
    if (rate) {
      const now = Date.now();
      if (now - rate.at > RATE_WINDOW_MS) {
        rate.at = now;
        rate.n = 0;
      }
      if (++rate.n > RATE_MAX_EVENTS) return; // M-7: no unbounded crypto and database work for a flood
    }
    const sub = this.subs.get(m[1]);
    const ev = m[2] as NostrEvent;
    if (!sub || !ev || typeof ev !== 'object' || typeof ev.content !== 'string' || typeof ev.kind !== 'number' || !sub.filter.kinds.includes(ev.kind)) return;
    if (!Array.isArray(ev.tags)) return;
    const tag = (name: string) => ev.tags.find((t) => Array.isArray(t) && t[0] === name && typeof t[1] === 'string');
    if (!ev.tags.some((t) => Array.isArray(t) && t[0] === 't' && sub.filter.tags.includes(t[1]))) return;
    const exp = tag('expiration');
    if (exp && Number(exp[1]) * 1000 < Date.now()) return; // NIP-40: expired
    const key = seenKey(ev.content);
    if (this.seen.has(key)) return; // the same message from several relays, or resent
    if (this.seen.size >= SEEN_MAX) this.seen.delete(this.seen.values().next().value!);
    this.seen.add(key);
    // The Nostr signature isn't checked: the content is locked and authenticated by our own keys.
    sub.fn(ev.content, ev);
  }

  /** Live subscription to events with any of `filter.tags`. Returns a function that ends it. */
  subscribe(filter: Filter | string, fn: (content: string, ev: NostrEvent) => void): () => void {
    const f: Filter = typeof filter === 'string' ? { kinds: [SIGNAL_KIND], tags: [filter] } : filter;
    const id = toHex(crypto.getRandomValues(new Uint8Array(8)));
    this.subs.set(id, { filter: f, fn });
    for (const ws of this.sockets.values()) if (ws.readyState === WebSocket.OPEN) this.req(ws, id, f);
    return () => {
      this.subs.delete(id);
      for (const ws of this.sockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['CLOSE', id]));
    };
  }

  /** Sends one event to every open relay; resolves with how many said OK (waits up to `waitMs`). */
  send(ev: NostrEvent, waitMs = 4000): Promise<number> {
    const open = [...this.sockets.values()].filter((ws) => ws.readyState === WebSocket.OPEN);
    if (!open.length) return Promise.resolve(0);
    return new Promise((resolve) => {
      let ok = 0;
      let answered = 0;
      const finish = () => {
        clearTimeout(t);
        this.oks.delete(ev.id);
        resolve(ok);
      };
      const t = setTimeout(finish, waitMs);
      this.oks.set(ev.id, (accepted) => {
        if (accepted) ok++;
        if (++answered >= open.length) finish();
      });
      const msg = JSON.stringify(['EVENT', ev]);
      for (const ws of open) ws.send(msg);
    });
  }

  publish(tag: string, content: string): number {
    const n = this.open().length;
    void this.send(makeEvent(this.secret, tag, content), 0);
    return n;
  }

  /**
   * Stores a locked message on the relays until `expiresMs` (capped at 24 h from now). Retries every
   * 3 s until at least `need` relays (2, or all of them if fewer) accepted it. Resolves with the count.
   */
  async store(tag: string, content: string, expiresMs: number, need = 2, giveUpMs = 60_000, what: PublishedRecord['what'] = 'reply'): Promise<number> {
    const started = Date.now();
    const exp = Math.min(Math.floor(expiresMs / 1000), Math.floor(Date.now() / 1000) + MAX_STORE_S);
    const d = toHex(crypto.getRandomValues(new Uint8Array(8)));
    for (;;) {
      if (this.closed) return 0;
      const want = Math.max(1, Math.min(need, this.open().length));
      const ev = makeEvent(this.secret, tag, content, Date.now(), STORED_KIND, [['d', d], ['expiration', String(exp)]]);
      const ok = await this.send(ev);
      if (ok > 0) RelayPool.onStored?.({ secret: toHex(this.secret), id: ev.id, kind: STORED_KIND, d, relays: this.open(), exp, what });
      if (ok >= want) return ok;
      if (Date.now() - started > giveUpMs) return ok;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  /** Asks the relays to delete events this device stored (NIP-09), each signed by its own key. Resolves with OK count. */
  async deleteStored(records: PublishedRecord[]): Promise<number> {
    let ok = 0;
    for (const r of records) ok += await this.send(deletionEvent(r), 3000);
    return ok;
  }

  /** Sends now and every `everyMs` until stop() is called or `maxMs` passes. */
  repeat(tag: string, content: string, everyMs = 3000, maxMs = 120_000, onGiveUp?: () => void): () => void {
    const started = Date.now();
    this.publish(tag, content);
    const t = setInterval(() => {
      if (this.closed) return clearInterval(t);
      if (Date.now() - started > maxMs) {
        clearInterval(t);
        onGiveUp?.();
        return;
      }
      this.publish(tag, content);
    }, everyMs);
    return () => clearInterval(t);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    for (const ws of this.all) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();
    this.subs.clear();
  }
}
