// On-device storage (IndexedDB). Nothing leaves the device.
//
// Secrets are SEALED at rest (security review M-1, core/vault.ts): the identity key ('me'), the device
// key ('device'), group sender keys ('groups'), the waiting 24 words ('unsavedWords'), the chat lock
// ('chatLock', 'chatLockDevice'; locked chats' messages are sealed by core/chatlock.ts), invite box
// secrets and pending reply secrets, under a non-extractable AES-GCM key kept in this database
// ('vaultKey'). Data written by older versions is sealed in place the first time it is read (and once
// right after the database opens). Not sealed: chat history of chats that are not locked, and contacts
// (no keys in them).
// Still to do (plan §5.2 step 3, §9 "Storage"): wrap the vault key with the phone's Keystore /
// Keychain in the apps, and an app lock.

import type { PublishedRecord } from '../net/relay';
import type { DeviceCert, StoredDevice } from './device';
import { isSealed, newVaultKey, openOrMigrate, sealValue, type Sealed } from './vault';

export interface StoredMe {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  name: string;
  created: number;
  /** "Join as guest": no 24 words, this browser only. */
  guest?: boolean;
}

/** One of this account's devices, as a contact last saw it (certificate checked). */
export interface SeenDevice {
  cert: DeviceCert;
  /** When a contact last saw this device connected. */
  seen: number;
}

export interface Contact {
  id: string; // 24-digit P2P ID
  publicKey: string; // base64url
  name: string;
  lastSeen: number;
  emoji?: string;
  /** Relays to use for the live hello with this contact. */
  relays?: string[];
  /** Their reply box key (base64url), when they joined through an invite. */
  replyBox?: string;
  /** Their devices I have seen (certificates checked), newest first. */
  devices?: SeenDevice[];
  /** I have sent them a message or accepted their call. Until then a "new contact": files ask first. */
  trusted?: boolean;
}

/** An invite link I made (sender side). */
export interface InviteRecord {
  id: string; // box / invite id, hex
  link: string;
  boxSecret: Uint8Array;
  created: number;
  expires: number;
  relays: string[];
  status: 'waiting' | 'used' | 'cancelled';
  usedBy?: string;
  usedById?: string;
  /** Identity keys (base64url) I blocked for this invite. */
  blocked: string[];
  /** 'id': the request box behind "Findable by my ID" (many uses, never shown in My invites). */
  kind?: 'invite' | 'id';
}

/** Someone's invite I opened and sent a request to (receiver side), until they accept. */
export interface PendingRecord {
  id: string; // their 24-digit P2P ID
  publicKey: string;
  name: string;
  inviteId: string;
  replySecret: Uint8Array;
  replyPub: Uint8Array;
  relays: string[];
  sentAt: number;
  expires: number;
}

export interface ChatMessage {
  key?: number;
  peer: string; // their 24-digit P2P ID
  from: 'me' | 'them';
  text: string;
  ts: number;
  mid: string;
  /** Group messages: the sender's name. */
  fromName?: string;
  /** Group messages: the sender's P2P ID (for their read receipt). */
  fromId?: string;
  /** A file message: what it is, and (when complete) the file itself. */
  file?: { name: string; size: number; type: string };
  blob?: Blob;
  /** In the phone apps: the received file in the app's folder (for Save / Share after a restart). */
  native?: { ref: string; name: string; size: number; mime: string };
  /**
   * In a browser: the received file's name in the browser's private file area (OPFS). Only this name is
   * kept here, never the file: an OPFS File put into IndexedDB is copied whole (BUG-7).
   */
  opfs?: string;
  /** A small preview of a photo or video (JPEG, made on this device from the local file). */
  thumb?: Blob;
  /** Chat lock (core/chatlock.ts): the message's contents, sealed. text is then '' and file, blob… are inside. */
  locked?: import('./chatlock').Box;
  /** A sealed message's file bytes kept in the database (small files only), sealed with a key inside `locked`. */
  lockedBlob?: Blob;
  /** A sealed message's received file in the phone app's folder: its opaque name, so start-up cleanup keeps it. */
  keepRef?: string;
  /** A note in the chat, not a message (e.g. "Ravi changed their photo"). */
  note?: boolean;
  /** My messages: wait (not sent yet) · sent · d (delivered) · r (read) (net/receipts.ts). Kept outside the chat-lock seal. */
  st?: import('../net/receipts').TickStatus;
  /** My group messages: per member, delivered or read. */
  rc?: Record<string, 'd' | 'r'>;
}

/** One call, for the Calls list. */
export interface CallRecord {
  peer: string;
  name: string;
  video: boolean;
  outgoing: boolean;
  /** How it ended: 'ended' (talked), 'missed', 'declined', 'failed'. */
  result: 'ended' | 'missed' | 'declined' | 'failed';
  ts: number;
  seconds: number;
}

let DB_NAME = 'p2ptalk';
let dbp: Promise<IDBDatabase> | null = null;

/** Use another database (embedded mode keeps each account apart). Call before anything is read. */
export function useDatabase(name: string): void {
  if (name === DB_NAME) return;
  if (dbp) void dbp.then((d) => d.close()).catch(() => undefined);
  dbp = null;
  vaultP = null;
  DB_NAME = name;
}

/** The database in use now. */
export const databaseName = (): string => DB_NAME;

/** Does a database with this name exist on this page's origin? (false where the browser can't tell) */
export async function databaseExists(name: string): Promise<boolean> {
  try {
    const list = await indexedDB.databases?.();
    return !!list?.some((d) => d.name === name);
  } catch {
    return false;
  }
}

/**
 * Another database's contacts and messages, read as stored (never opened for writing, never created).
 * Host mode uses it once to carry an embedded account's chats over (see main.ts "host mode").
 */
export async function readOtherChats(name: string): Promise<{ contacts: Contact[]; messages: ChatMessage[] }> {
  if (!(await databaseExists(name))) return { contacts: [], messages: [] };
  const d = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onupgradeneeded = () => req.transaction?.abort(); // it would be new: don't make it
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    if (!d.objectStoreNames.contains('contacts') || !d.objectStoreNames.contains('messages')) return { contacts: [], messages: [] };
    const all = <T>(store: string) =>
      new Promise<T[]>((resolve, reject) => {
        const r = d.transaction(store).objectStore(store).getAll();
        r.onsuccess = () => resolve(r.result as T[]);
        r.onerror = () => reject(r.error);
      });
    return { contacts: await all<Contact>('contacts'), messages: await all<ChatMessage>('messages') };
  } finally {
    d.close();
  }
}

/** A small flag in this database (e.g. "carried over once"). */
export const loadFlag = (key: string) => run<unknown>('kv', 'readonly', (s) => s.get(`flag:${key}`)).then((v) => v !== undefined);
export const saveFlag = (key: string) => run('kv', 'readwrite', (s) => s.put(Date.now(), `flag:${key}`));

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = (e) => {
      const d = req.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('kv');
        d.createObjectStore('contacts', { keyPath: 'id' });
        d.createObjectStore('messages', { keyPath: 'key', autoIncrement: true }).createIndex('peer', 'peer');
      }
      if (e.oldVersion < 2) {
        d.createObjectStore('invites', { keyPath: 'id' });
        d.createObjectStore('pending', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!migrated.has(DB_NAME)) {
    migrated.add(DB_NAME);
    // Seal what an older version left unsealed (once per database and page load).
    void dbp.then(() => setTimeout(() => void sealOldSecrets().catch(() => undefined), 0)).catch(() => undefined); // the caller reports an open failure
  }
  return dbp;
}

// ---- sealing secrets (core/vault.ts) --------------------------------------------------------------

const migrated = new Set<string>();
let vaultP: Promise<CryptoKey | null> | null = null;

/** This database's sealing key (made on first use). null only where a browser can't keep one. */
function vault(): Promise<CryptoKey | null> {
  vaultP ??= (async () => {
    try {
      const have = await run<unknown>('kv', 'readonly', (s) => s.get('vaultKey'));
      if (have instanceof CryptoKey) return have;
      const k = await newVaultKey();
      try {
        await run('kv', 'readwrite', (s) => s.add(k, 'vaultKey')); // add: never replaces a key another tab just made
        return k;
      } catch {
        const again = await run<unknown>('kv', 'readonly', (s) => s.get('vaultKey'));
        if (again instanceof CryptoKey) return again;
        throw new Error('no vault key');
      }
    } catch (e) {
      console.warn('P2P Talk: this browser cannot seal stored keys', e);
      return null;
    }
  })();
  return vaultP;
}

/** In one transaction: replace the stored value only if it is still the old, unsealed one. */
function replaceIfPlain(store: string, key: IDBValidKey, next: (cur: unknown) => unknown | null): Promise<void> {
  return db().then(
    (d) =>
      new Promise<void>((resolve, reject) => {
        const tx = d.transaction(store, 'readwrite');
        const s = tx.objectStore(store);
        const g = s.get(key);
        g.onsuccess = () => {
          const v = g.result === undefined ? null : next(g.result);
          if (v !== null) {
            if (s.keyPath) s.put(v);
            else s.put(v, key);
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

async function getSecret<T>(slot: string): Promise<T | undefined> {
  const raw = await run<unknown>('kv', 'readonly', (s) => s.get(slot));
  return openOrMigrate<T>(await vault(), slot, raw, (sealed) => replaceIfPlain('kv', slot, (cur) => (isSealed(cur) ? null : sealed)));
}

async function putSecret(slot: string, value: unknown): Promise<void> {
  const k = await vault();
  const v = k ? await sealValue(k, slot, value) : value;
  await run('kv', 'readwrite', (s) => s.put(v, slot));
}

/** A record with one secret field (invites: boxSecret, pending: replySecret), as stored. */
async function sealField<R extends { id: string }>(r: R, field: keyof R & string, slot: string): Promise<R> {
  const k = await vault();
  return k ? { ...r, [field]: await sealValue(k, slot, r[field]) } : r;
}

async function openField<R extends { id: string }>(store: string, r: R, field: keyof R & string, slot: string): Promise<R> {
  const value = await openOrMigrate<R[typeof field]>(await vault(), slot, r[field], (sealed: Sealed) =>
    replaceIfPlain(store, r.id, (cur) => (isSealed((cur as R)[field]) ? null : { ...(cur as R), [field]: sealed })),
  );
  return { ...r, [field]: value };
}

/** Seals everything an older version stored unsealed. Reading each one seals it in place. */
async function sealOldSecrets(): Promise<void> {
  await Promise.all([loadMe(), loadDevice(), loadUnsavedWords(), loadGroupsState(), loadInvites(), loadPending()]);
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export const loadMe = () => getSecret<StoredMe>('me');
export const saveMe = (me: StoredMe) => putSecret('me', me);

export const saveContact = (c: Contact) => run('contacts', 'readwrite', (s) => s.put(c));
export const loadContact = (id: string) => run<Contact | undefined>('contacts', 'readonly', (s) => s.get(id));

export const deleteContact = (id: string) => run('contacts', 'readwrite', (s) => s.delete(id));

export const loadContacts = () => run<Contact[]>('contacts', 'readonly', (s) => s.getAll());

export const saveInvite = async (i: InviteRecord) => {
  const r = await sealField(i, 'boxSecret', `invite:${i.id}`);
  await run('invites', 'readwrite', (s) => s.put(r));
};
export const loadInvites = async () => {
  const l = await run<InviteRecord[]>('invites', 'readonly', (s) => s.getAll());
  const out = await Promise.all(l.map((r) => openField('invites', r, 'boxSecret', `invite:${r.id}`)));
  return out.sort((a, b) => b.created - a.created);
};

export const savePending = async (p: PendingRecord) => {
  const r = await sealField(p, 'replySecret', `pending:${p.id}`);
  await run('pending', 'readwrite', (s) => s.put(r));
};
export const loadPending = async () => {
  const l = await run<PendingRecord[]>('pending', 'readonly', (s) => s.getAll());
  return Promise.all(l.map((r) => openField('pending', r, 'replySecret', `pending:${r.id}`)));
};
export const deletePending = (id: string) => run('pending', 'readwrite', (s) => s.delete(id));

export const addMessage = (m: ChatMessage) => run<IDBValidKey>('messages', 'readwrite', (s) => s.add(m)).then((k) => k as number);
export const loadMessages = (peer: string) =>
  run<ChatMessage[]>('messages', 'readonly', (s) => s.index('peer').getAll(peer)).then((list) =>
    list.sort((a, b) => a.ts - b.ts),
  );

/** Replaces a stored message (e.g. a file message once the file is complete). */
export const putMessage = (m: ChatMessage) => run('messages', 'readwrite', (s) => s.put(m));

/** Every stored message of one chat, as stored (sealed ones stay sealed). */
export const loadStoredMessages = (peer: string) => run<ChatMessage[]>('messages', 'readonly', (s) => s.index('peer').getAll(peer));

/** All stored messages that still hold a file in the database (BUG-7 move to the private file area). */
export async function loadMessagesWithBlobs(): Promise<ChatMessage[]> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const out: ChatMessage[] = [];
    const tx = d.transaction('messages', 'readonly');
    const req = tx.objectStore('messages').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const m = c.value as ChatMessage;
      if (m.blob instanceof Blob) out.push(m);
      c.continue();
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
}

// ---- Chat lock (core/chatlock.ts, core/locks.ts) ---------------------------------------------------

/** The lock record (sealed by the vault like the identity key). */
export const loadChatLock = () => getSecret<import('./chatlock').LockRecord>('chatLock');
/** This device's 32-byte chat lock secret (sealed by the vault). */
export const loadLockSecret = () => getSecret<Uint8Array>('chatLockDevice');
export const saveLockSecret = (b: Uint8Array) => putSecret('chatLockDevice', b);
/** Wrong codes in a row, and until when the next try waits (kept across reloads). */
export const loadLockTries = () => run<{ fails: number; until: number } | undefined>('kv', 'readonly', (s) => s.get('chatLockTries')).then((t) => t ?? { fails: 0, until: 0 });
export const saveLockTries = (t: { fails: number; until: number }) => run('kv', 'readwrite', (s) => s.put(t, 'chatLockTries'));

/**
 * One transaction: write these messages, delete every message of these chats, and store (or with
 * null, remove) the lock record. Locking, unlocking, changing the code and "forgot code" all go
 * through here, so a crash never leaves a chat half sealed under one lock and half under another.
 */
export async function commitChatLock(put: ChatMessage[], deleteChats: string[], lock: unknown | null): Promise<void> {
  const k = await vault();
  const lockValue = lock === null ? null : k ? await sealValue(k, 'chatLock', lock) : lock;
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(['messages', 'kv'], 'readwrite');
    const ms = tx.objectStore('messages');
    for (const peer of deleteChats) {
      const r = ms.index('peer').getAllKeys(peer);
      r.onsuccess = () => {
        for (const key of r.result) ms.delete(key);
      };
    }
    for (const m of put) ms.put(m);
    const kv = tx.objectStore('kv');
    if (lockValue === null) kv.delete('chatLock');
    else kv.put(lockValue, 'chatLock');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Unread counts: per contact, the key of the last message I have seen. */
export const loadReadMarks = () => run<Record<string, number> | undefined>('kv', 'readonly', (s) => s.get('read')).then((r) => r ?? {});
export async function markRead(peer: string, key: number): Promise<void> {
  const r = await loadReadMarks();
  if ((r[peer] ?? 0) >= key) return;
  r[peer] = key;
  await run('kv', 'readwrite', (s) => s.put(r, 'read'));
}

/** The Calls list (newest first, at most 100). */
export const loadCalls = () => run<CallRecord[] | undefined>('kv', 'readonly', (s) => s.get('calls')).then((l) => l ?? []);
export async function addCall(c: CallRecord): Promise<void> {
  const l = [c, ...(await loadCalls())].slice(0, 100);
  await run('kv', 'readwrite', (s) => s.put(l, 'calls'));
}

/** Calls list: remove one call (by its time and person), or all of them ("Clear all"). */
export async function removeCall(c: Pick<CallRecord, 'ts' | 'peer'>): Promise<void> {
  const l = (await loadCalls()).filter((x) => !(x.ts === c.ts && x.peer === c.peer));
  await run('kv', 'readwrite', (s) => s.put(l, 'calls'));
}
export const clearCalls = () => run('kv', 'readwrite', (s) => s.delete('calls'));

/**
 * Deletes every stored message of one chat (a contact's P2P ID, or "g:<group id>") and its unread
 * mark, in one transaction. Files the messages point to are deleted by the caller (core/forget.ts).
 */
export async function deleteChatMessages(chat: string): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(['messages', 'kv'], 'readwrite');
    const ms = tx.objectStore('messages');
    const r = ms.index('peer').getAllKeys(chat);
    r.onsuccess = () => {
      for (const key of r.result) ms.delete(key);
    };
    const kv = tx.objectStore('kv');
    const marks = kv.get('read');
    marks.onsuccess = () => {
      const m = marks.result as Record<string, number> | undefined;
      if (m && chat in m) {
        delete m[chat];
        kv.put(m, 'read');
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * People I deleted (Delete chat): only who they are (key, name, relays), never messages, so that when
 * they try to reconnect it shows as a request ("Ravi wants to talk again": Accept / Block) instead of
 * being taken back by itself or ignored. Kept 90 days, at most 200.
 */
export interface DeletedContact {
  publicKey: string;
  id: string;
  name: string;
  relays: string[];
  at: number;
}
const DELETED_DAYS = 90;
export async function loadDeletedContacts(): Promise<DeletedContact[]> {
  const l = (await run<DeletedContact[] | undefined>('kv', 'readonly', (s) => s.get('deletedContacts'))) ?? [];
  return l.filter((d) => d.at > Date.now() - DELETED_DAYS * 86400_000);
}
export async function addDeletedContact(c: Contact): Promise<void> {
  const l = (await loadDeletedContacts()).filter((d) => d.publicKey !== c.publicKey);
  l.push({ publicKey: c.publicKey, id: c.id, name: c.name, relays: (c.relays ?? []).slice(0, 8), at: Date.now() });
  await run('kv', 'readwrite', (s) => s.put(l.slice(-200), 'deletedContacts'));
}
export async function removeDeletedContact(publicKey: string): Promise<void> {
  const l = (await loadDeletedContacts()).filter((d) => d.publicKey !== publicKey);
  await run('kv', 'readwrite', (s) => s.put(l, 'deletedContacts'));
}

/** Muted chats (a contact's P2P ID, or "g:<group id>"): no "New message" alert, not counted on the tab. */
export const loadMuted = () => run<string[] | undefined>('kv', 'readonly', (s) => s.get('muted')).then((l) => l ?? []);
export async function setMuted(chat: string, on: boolean): Promise<void> {
  const l = (await loadMuted()).filter((x) => x !== chat);
  if (on) l.push(chat);
  await run('kv', 'readwrite', (s) => s.put(l, 'muted'));
}

/** A contact's or group's picture kept on this device: removed with the chat. */
export async function deletePic(key: string): Promise<void> {
  const p = await loadPics();
  if (!(key in p)) return;
  delete p[key];
  await savePics(p);
}

/** "Remove my account from this device": deletes everything stored here. */
export async function wipeAll(): Promise<void> {
  if (dbp) (await dbp).close();
  dbp = null;
  vaultP = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

// ---- Instant join: the 24 words, until the person has written them down ---------------------------
// "Join" from an invite makes the account at once and shows the words afterwards (never blocking the
// join). Until the person taps "I've written them down", the words wait here, sealed like the key.

export const loadUnsavedWords = () => getSecret<string>('unsavedWords');
export const saveUnsavedWords = (phrase: string) => putSecret('unsavedWords', phrase);
export const clearUnsavedWords = () => run('kv', 'readwrite', (s) => s.delete('unsavedWords'));

// ---- This device, other devices of mine, blocked people ------------------------------------------

export const loadDevice = () => getSecret<StoredDevice>('device');
export const saveDevice = (d: StoredDevice) => putSecret('device', d);

/** My other devices that contacts told me they saw (certificates checked against my identity key). */
export const loadMyDevices = () => run<SeenDevice[] | undefined>('kv', 'readonly', (s) => s.get('myDevices')).then((l) => l ?? []);
export const saveMyDevices = (l: SeenDevice[]) => run('kv', 'readwrite', (s) => s.put(l, 'myDevices'));

/** Identity keys (base64url) I blocked: their reconnects, invite requests and offers are ignored. */
export const loadBlocked = () => run<string[] | undefined>('kv', 'readonly', (s) => s.get('blocked')).then((l) => l ?? []);
export async function addBlocked(publicKey: string): Promise<void> {
  const l = await loadBlocked();
  if (!l.includes(publicKey)) await run('kv', 'readwrite', (s) => s.put([...l, publicKey], 'blocked'));
}

// ---- Stored relay events I made (to ask for their deletion, NIP-09) -------------------------------

export const loadPublished = () => run<PublishedRecord[] | undefined>('kv', 'readonly', (s) => s.get('published')).then((l) => l ?? []);
export async function addPublished(r: PublishedRecord): Promise<void> {
  const now = Date.now() / 1000;
  const l = [...(await loadPublished()).filter((x) => x.exp > now), r].slice(-200);
  await run('kv', 'readwrite', (s) => s.put(l, 'published'));
}
export const savePublished = (l: PublishedRecord[]) => run('kv', 'readwrite', (s) => s.put(l, 'published'));

/** When my ID card was last put on the relays (it is published again only when near expiry). */
export const loadCardPublishedAt = () => run<number | undefined>('kv', 'readonly', (s) => s.get('cardAt'));
export const saveCardPublishedAt = (t: number) => run('kv', 'readwrite', (s) => s.put(t, 'cardAt'));

// ---- Groups: records, history and sender keys (sealed like the identity key) ----------------------

export const loadGroupsState = () => getSecret<unknown>('groups');
export const saveGroupsState = (st: unknown) => putSecret('groups', st);

// ---- One-scan connect settings -----------------------------------------------------------------

/** Which built-in relays this device uses for its own codes (undefined = all). */
export const loadRelayChoice = () => run<string[] | undefined>('kv', 'readonly', (s) => s.get('relays'));
export const saveRelayChoice = (relays: string[]) => run('kv', 'readwrite', (s) => s.put(relays, 'relays'));

/** Codes this device already used (single use, also on this side). */
export async function wasCardUsed(boxId: string): Promise<boolean> {
  const used = (await run<Record<string, number> | undefined>('kv', 'readonly', (s) => s.get('usedCards'))) ?? {};
  return boxId in used;
}

export async function markCardUsed(boxId: string, expires: number): Promise<void> {
  const used = (await run<Record<string, number> | undefined>('kv', 'readonly', (s) => s.get('usedCards'))) ?? {};
  const now = Date.now();
  for (const [k, exp] of Object.entries(used)) if (exp < now - 3600_000) delete used[k];
  used[boxId] = expires;
  await run('kv', 'readwrite', (s) => s.put(used, 'usedCards'));
}

// ---- Pictures (core/photo.ts): mine, its visibility, and the ones I keep for contacts and groups ------
// Kept only on this device; they reach others only directly over the locked link (net/photos.ts).

export const loadMyPhoto = () => run<import('./photo').StoredPhoto | undefined>('kv', 'readonly', (s) => s.get('myPhoto'));
export const saveMyPhoto = (p: import('./photo').StoredPhoto | null) => run<unknown>('kv', 'readwrite', (s) => (p ? s.put(p, 'myPhoto') : s.delete('myPhoto')) as IDBRequest<unknown>);
/** Who can see my picture: 'contacts' (default) or 'nobody'. */
export const loadPhotoVisibility = () => run<'contacts' | 'nobody' | undefined>('kv', 'readonly', (s) => s.get('photoVis')).then((v) => v ?? 'contacts');
export const savePhotoVisibility = (v: 'contacts' | 'nobody') => run('kv', 'readwrite', (s) => s.put(v, 'photoVis'));
/** Pictures by key: a contact's (or group member's) P2P ID, or "g:<group id>". */
export const loadPics = () => run<Record<string, import('./photo').StoredPhoto> | undefined>('kv', 'readonly', (s) => s.get('pics')).then((p) => p ?? {});
export const savePics = (p: Record<string, import('./photo').StoredPhoto>) => run('kv', 'readwrite', (s) => s.put(p, 'pics'));

// ---- Ticks (net/receipts.ts) -------------------------------------------------------------------------

/** Read receipts on (default) or off: off sends none and shows nobody's blue ticks. */
export const loadReadReceipts = () => run<boolean | undefined>('kv', 'readonly', (s) => s.get('readReceipts')).then((v) => v !== false);
export const saveReadReceipts = (on: boolean) => run('kv', 'readwrite', (s) => s.put(on, 'readReceipts'));
/** Receipts I still owe people who were offline. */
export const loadReceiptOutbox = () => run<[string, import('../net/receipts').Receipt[]][] | undefined>('kv', 'readonly', (s) => s.get('rcptOut'));
export const saveReceiptOutbox = (v: [string, import('../net/receipts').Receipt[]][]) => run('kv', 'readwrite', (s) => s.put(v, 'rcptOut'));
/** One stored message by chat and id (as stored: sealed ones stay sealed). */
export async function findStoredMessage(peer: string, mid: string): Promise<ChatMessage | undefined> {
  return (await loadStoredMessages(peer)).find((m) => m.mid === mid);
}
