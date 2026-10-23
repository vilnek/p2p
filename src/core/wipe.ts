// "Delete my account and data" (Me › Settings): Play policy asks chat apps for in-app account deletion.
//
// There is no server and no account database, so "the account" is what this device holds plus the
// few events it left on public relays. In order:
//   1. ask the relays to delete what this device stored there (our public ID card, invite requests
//      and replies): NIP-09 kind-5 events, each signed by the throwaway key that stored the event;
//      all sent at once, waiting at most ~3 s for the relays' OKs (they also expire by themselves
//      within 24 h, NIP-40);
//   2. wipe this device: every IndexedDB database the app uses ('p2ptalk' and the embedded mode's
//      'p2ptalk-embed-*'; groups state and the published list live inside them), the private file
//      area (OPFS folder 'p2p-files'; in the phone apps, the app's received-files folder), and our
//      localStorage / sessionStorage keys.
// Other devices with the same 24 words keep their own copy.

import { deletionEvent, RelayPool, type NostrEvent, type PublishedRecord } from '../net/relay';
import { cleanupNativeFiles } from '../native/nativeFiles';
import { wipeAll } from './store';

/** The confirm sheet's words (Me › Settings › Delete my account and data). */
export const DELETE_TITLE = 'Delete my account and data?';
export const DELETE_TEXT =
  'This erases your keys, chats, contacts and files from this device and removes your public card. ' +
  'Other devices with the same 24 words keep their copy. This can’t be undone.';
export const DELETE_BUTTON = 'Delete';

/** IndexedDB names the app uses: 'p2ptalk' (the app) and 'p2ptalk-embed-<hash>' (embedded mode). */
export const DB_PREFIX = 'p2ptalk';
/** OPFS folder for received files (src/core/sinks.ts). */
export const OPFS_DIR = 'p2p-files';
/** Storage keys we set: 'p2p-last-name', 'p2p-pending-link', 'p2ptalk-embed-last', and any later 'p2p…' key. */
export const KEY_PREFIX = 'p2p';

// ---- 1. relays ------------------------------------------------------------------------------------

/** The part of a relay pool used here (RelayPool, or a fake in tests). */
export interface DeletePool {
  connect(limitMs: number): Promise<string[]>;
  send(ev: NostrEvent, waitMs: number): Promise<number>;
  close(): void;
}

export interface RelayDeleteOptions {
  /** Only these relays are contacted (the app's allowed list). Default: any. */
  allowed?: string[];
  /** Longest wait for the relays to open. */
  connectMs?: number;
  /** Longest wait for their OKs, once open. */
  waitMs?: number;
  now?: number;
  pool?: (urls: string[]) => DeletePool;
}

export interface RelayDeleteResult {
  /** Deletion events sent (one per stored event still alive). */
  asked: number;
  /** OKs received, over all relays. */
  ok: number;
}

/** Asks the relays to delete every stored event in `records` (NIP-09). Never throws. */
export async function deleteFromRelays(records: PublishedRecord[], o: RelayDeleteOptions = {}): Promise<RelayDeleteResult> {
  const now = o.now ?? Date.now();
  const makePool = o.pool ?? ((urls: string[]) => new RelayPool(urls));
  // Same relays -> one pool. Expired events are gone already; a record seen twice is asked once.
  const groups = new Map<string, { urls: string[]; events: NostrEvent[] }>();
  const seen = new Set<string>();
  for (const r of records) {
    if (r.exp * 1000 <= now || seen.has(r.id)) continue;
    const urls = [...new Set(r.relays)].filter((u) => !o.allowed || o.allowed.includes(u)).sort();
    if (!urls.length) continue;
    let ev: NostrEvent;
    try {
      ev = deletionEvent(r, now);
    } catch {
      continue; // a damaged record: nothing to sign with
    }
    seen.add(r.id);
    const key = urls.join(' ');
    if (!groups.has(key)) groups.set(key, { urls, events: [] });
    groups.get(key)!.events.push(ev);
  }
  const counts = await Promise.all(
    [...groups.values()].map(async ({ urls, events }) => {
      const pool = makePool(urls);
      try {
        const open = await pool.connect(o.connectMs ?? 2500).catch(() => [] as string[]);
        if (!open.length) return 0;
        const oks = await Promise.all(events.map((ev) => pool.send(ev, o.waitMs ?? 3000).catch(() => 0)));
        return oks.reduce((a, b) => a + b, 0);
      } finally {
        pool.close();
      }
    }),
  );
  return { asked: seen.size, ok: counts.reduce((a, b) => a + b, 0) };
}

// ---- 2. this device ------------------------------------------------------------------------------

interface IdbLike {
  databases?(): Promise<{ name?: string }[]>;
  deleteDatabase(name: string): { onsuccess: unknown; onerror: unknown; onblocked: unknown; error?: unknown };
}
interface StorageLike {
  readonly length: number;
  key(i: number): string | null;
  removeItem(k: string): void;
}
interface DirLike {
  removeEntry(name: string, o?: { recursive?: boolean }): Promise<void>;
}

/** Where wipeDevice() deletes (the browser's own by default; fakes in tests). */
export interface WipeEnv {
  idb?: IdbLike | null;
  local?: StorageLike | null;
  session?: StorageLike | null;
  opfs?: (() => Promise<DirLike>) | null;
  /** Closes and deletes the database the app has open now (store.ts). */
  closeOpen?: () => Promise<void>;
  /** Phone apps: removes every received file from the app's own folder (does nothing in a browser). */
  nativeFiles?: () => Promise<void>;
}

export interface WipeResult {
  databases: string[];
  keys: string[];
  files: boolean;
}

function safe<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

function browserEnv(): WipeEnv {
  const g = globalThis as unknown as { indexedDB?: IdbLike; localStorage?: StorageLike; sessionStorage?: StorageLike; navigator?: { storage?: { getDirectory?: () => Promise<DirLike> } } };
  const dir = g.navigator?.storage?.getDirectory;
  return {
    idb: safe(() => g.indexedDB ?? null),
    local: safe(() => g.localStorage ?? null),
    session: safe(() => g.sessionStorage ?? null),
    opfs: dir ? () => dir.call(g.navigator!.storage) : null,
    closeOpen: wipeAll,
    nativeFiles: () => cleanupNativeFiles([]),
  };
}

function deleteDb(idb: IdbLike, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let req: ReturnType<IdbLike['deleteDatabase']>;
    try {
      req = idb.deleteDatabase(name);
    } catch {
      return resolve(false);
    }
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
    req.onblocked = () => resolve(true); // deleted as soon as the last connection closes
  });
}

function removeKeys(s: StorageLike | null | undefined): string[] {
  if (!s) return [];
  const keys: string[] = [];
  safe(() => {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(KEY_PREFIX)) keys.push(k);
    }
  });
  for (const k of keys) safe(() => s.removeItem(k));
  return keys;
}

/** Erases everything the app keeps on this device. Never throws; says what it removed. */
export async function wipeDevice(env: WipeEnv = browserEnv()): Promise<WipeResult> {
  await env.closeOpen?.().catch(() => undefined);
  const databases: string[] = [];
  if (env.idb) {
    const listed = (await env.idb.databases?.().catch(() => []).then((l) => l.map((d) => d.name ?? ''))) ?? [];
    const names = [...new Set([DB_PREFIX, ...listed.filter((n) => n === DB_PREFIX || n.startsWith(`${DB_PREFIX}-`))])];
    for (const n of names) if (await deleteDb(env.idb, n)) databases.push(n);
  }
  let files = false;
  if (env.opfs) {
    files = await env
      .opfs()
      .then((root) => root.removeEntry(OPFS_DIR, { recursive: true }))
      .then(
        () => true,
        (e: { name?: string }) => e?.name === 'NotFoundError', // nothing was there
      );
  }
  if (env.nativeFiles) await env.nativeFiles().catch(() => undefined);
  const keys = [...removeKeys(env.local), ...removeKeys(env.session)];
  return { databases, keys, files };
}

// ---- both ----------------------------------------------------------------------------------------

/** 1 then 2. The caller stops its connections first and shows Welcome afterwards. */
export async function deleteAccount(records: PublishedRecord[], o: RelayDeleteOptions & { env?: WipeEnv } = {}): Promise<RelayDeleteResult & WipeResult> {
  const relays = await deleteFromRelays(records, o).catch(() => ({ asked: 0, ok: 0 }));
  const device = await wipeDevice(o.env);
  return { ...relays, ...device };
}
