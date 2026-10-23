// The chat lock's state on this device (crypto in core/chatlock.ts, storage in core/store.ts):
// which chats are locked, whether they are open right now (the code was typed), wrong-code waits,
// and sealing / opening each message as it is stored or read.
//
// While locked, new messages of a locked chat are sealed with the lock's public key as they arrive;
// reading them needs the code. "Open" lasts until close(): the screens close it when the person leaves
// the locked chats, and after 1 minute in the background (main.ts).

import { ARGON2, isBox, newLock, openBytes, openLock, seal, sealBytes, unseal, waitAfter, WrongCode, type Argon2Params, type LockRecord, type OpenLock } from './chatlock';
import type { ChatMessage } from './store';

export interface LockStorage {
  loadLock(): Promise<LockRecord | undefined>;
  loadSecret(): Promise<Uint8Array | undefined>;
  saveSecret(b: Uint8Array): Promise<void>;
  loadTries(): Promise<{ fails: number; until: number }>;
  saveTries(t: { fails: number; until: number }): Promise<void>;
  /** One chat's stored messages (sealed ones as stored). */
  messages(chat: string): Promise<ChatMessage[]>;
  add(m: ChatMessage): Promise<number>;
  commit(put: ChatMessage[], deleteChats: string[], lock: LockRecord | null): Promise<void>;
}

/** What goes inside a sealed message. */
interface Inside {
  text: string;
  fromName?: string;
  fromId?: string;
  file?: ChatMessage['file'];
  native?: ChatMessage['native'];
  opfs?: string;
  thumb?: { b: Uint8Array; t: string };
  /** The key of the sealed file bytes in lockedBlob. */
  fk?: Uint8Array;
}

/** The result of a try with the code: ok, or how many seconds until the next try. */
export interface Try {
  ok: boolean;
  wait: number;
}

export class ChatLocks {
  private rec: LockRecord | null = null;
  private opened: OpenLock | null = null;
  private secret: Uint8Array | null = null;
  private set = new Set<string>();
  /** Resolves once the lock record is read (screens wait for it before listing chats). */
  ready: Promise<void> = Promise.resolve();
  /** Called when the lock opens or closes, or the locked chats change. */
  onChange: () => void = () => {};

  constructor(
    private st: LockStorage,
    private params: Argon2Params = ARGON2,
    private now: () => number = () => Date.now(),
  ) {}

  load(): Promise<void> {
    this.ready = (async () => {
      this.rec = (await this.st.loadLock()) ?? null;
      this.set = new Set(this.rec?.chats ?? []);
    })();
    return this.ready;
  }

  /** A secret code has been set on this device. */
  get isSet(): boolean {
    return !!this.rec;
  }

  /** The code was typed and the locked chats are open. */
  get isOpen(): boolean {
    return !!this.opened;
  }

  isLocked(chat: string): boolean {
    return this.set.has(chat);
  }

  get chats(): string[] {
    return [...this.set];
  }

  /** Locks the locked chats again (forgets the opened key). */
  close(): void {
    if (!this.opened) return;
    this.opened = null;
    this.onChange();
  }

  private async deviceSecret(): Promise<Uint8Array> {
    if (this.secret) return this.secret;
    let s = await this.st.loadSecret();
    if (!s) {
      s = crypto.getRandomValues(new Uint8Array(32));
      await this.st.saveSecret(s);
    }
    return (this.secret = s);
  }

  /** Seconds until the next try is allowed (after wrong codes). */
  async waitLeft(): Promise<number> {
    const t = await this.st.loadTries();
    return Math.max(0, Math.ceil((t.until - this.now()) / 1000));
  }

  /** Checks the code (with the growing wait after wrong ones). Returns the opened lock, or the wait. */
  private async check(code: string): Promise<OpenLock | Try> {
    if (!this.rec) throw new Error('No secret code is set.');
    const tries = await this.st.loadTries();
    if (tries.until > this.now()) return { ok: false, wait: Math.ceil((tries.until - this.now()) / 1000) };
    try {
      const o = await openLock(this.rec, code, await this.deviceSecret());
      if (tries.fails) await this.st.saveTries({ fails: 0, until: 0 });
      return o;
    } catch (e) {
      if (!(e instanceof WrongCode)) throw e;
      const fails = tries.fails + 1;
      const wait = waitAfter(fails);
      await this.st.saveTries({ fails, until: this.now() + wait * 1000 });
      return { ok: false, wait };
    }
  }

  /** Opens the locked chats with the code. */
  async unlock(code: string): Promise<Try> {
    const r = await this.check(code);
    if ('ok' in r) return r;
    this.opened = r;
    this.onChange();
    return { ok: true, wait: 0 };
  }

  /** First time: sets the secret code (entered twice by the person; checked by the screen). */
  async setCode(code: string): Promise<void> {
    if (this.rec) throw new Error('A secret code is already set.');
    const { record } = await newLock(code, await this.deviceSecret(), [], this.params);
    await this.st.commit([], [], record);
    this.rec = record;
    this.onChange();
  }

  /** Locks a chat: its stored messages are sealed now; new ones as they arrive. No code needed. */
  async lock(chat: string): Promise<void> {
    if (!this.rec) throw new Error('Set a secret code first.');
    if (this.set.has(chat)) return;
    this.set.add(chat); // first: messages arriving from now on are sealed
    try {
      const put: ChatMessage[] = [];
      for (const m of await this.st.messages(chat)) if (!m.locked) put.push(await this.sealWith(this.rec.pub, m));
      const rec = { ...this.rec, chats: [...this.set] };
      await this.st.commit(put, [], rec);
      this.rec = rec;
    } catch (e) {
      this.set.delete(chat);
      throw e;
    }
    this.onChange();
  }

  /** Removes the lock from one chat (the locked chats must be open): its messages are stored plain again. */
  async unlockChat(chat: string): Promise<void> {
    if (!this.rec || !this.opened) throw new Error('Type your secret code first.');
    const put: ChatMessage[] = [];
    for (const m of await this.st.messages(chat)) if (m.locked) put.push(await this.openWith(this.opened, m));
    this.set.delete(chat);
    const rec = { ...this.rec, chats: [...this.set] };
    await this.st.commit(put, [], rec);
    this.rec = rec;
    this.onChange();
  }

  /**
   * Change the secret code: a new key pair, and every locked chat's messages sealed again under it, in
   * one transaction (the old code then opens nothing). File bytes keep their own key (inside the seal).
   */
  async changeCode(oldCode: string, newCode: string): Promise<Try> {
    const r = await this.check(oldCode);
    if ('ok' in r) return r;
    const { record, open } = await newLock(newCode, await this.deviceSecret(), [...this.set], this.params);
    const put: ChatMessage[] = [];
    for (const chat of this.set)
      for (const m of await this.st.messages(chat)) {
        const plain = m.locked ? await this.openWith(r, m, true) : m;
        put.push(await this.sealWith(record.pub, plain, m.locked ? m.lockedBlob : undefined));
      }
    await this.st.commit(put, [], record);
    this.rec = record;
    if (this.opened) this.opened = open;
    this.onChange();
    return { ok: true, wait: 0 };
  }

  /** "Forgot code": removes the lock and deletes the locked chats' messages on this device. */
  async forget(): Promise<string[]> {
    const gone = [...this.set];
    await this.st.commit([], gone, null);
    await this.st.saveTries({ fails: 0, until: 0 });
    this.rec = null;
    this.opened = null;
    this.set.clear();
    this.onChange();
    return gone;
  }

  /**
   * A locked chat was deleted (Delete chat, Delete group): its sealed messages go and it leaves the
   * lock, in one transaction. No code needed (nothing is shown). Other locked chats stay as they are.
   */
  async dropChat(chat: string): Promise<void> {
    await this.ready;
    if (!this.rec || !this.set.has(chat)) return;
    const rec = { ...this.rec, chats: [...this.set].filter((c) => c !== chat) };
    await this.st.commit([], [chat], rec);
    this.rec = rec;
    this.set.delete(chat);
    this.onChange();
  }

  /** Stores a message: sealed if its chat is locked. Returns its key. */
  async store(m: ChatMessage): Promise<number> {
    await this.ready;
    if (this.rec && this.set.has(m.peer)) return this.st.add(await this.sealWith(this.rec.pub, m));
    return this.st.add(m);
  }

  /** A chat's messages, oldest first, opened. null: the chat is locked and the code wasn't typed. */
  async read(chat: string): Promise<ChatMessage[] | null> {
    await this.ready;
    const stored = (await this.st.messages(chat)).sort((a, b) => a.ts - b.ts);
    if (this.set.has(chat) && !this.opened) return null;
    const out: ChatMessage[] = [];
    for (const m of stored) {
      if (!m.locked) out.push(m);
      else if (this.opened) out.push(await this.openWith(this.opened, m).catch(() => ({ ...m, text: '' })));
    }
    return out;
  }

  // ---- one message ---------------------------------------------------------------------------------

  /** `keepBlob`: an already sealed file (change code): kept as it is, its key is in `m` (from openWith(…, true)). */
  private async sealWith(pub: Uint8Array, m: ChatMessage, keepBlob?: Blob): Promise<ChatMessage> {
    const inside: Inside = { text: m.text };
    if (m.fromName) inside.fromName = m.fromName;
    if (m.fromId) inside.fromId = m.fromId;
    if (m.file) inside.file = m.file;
    if (m.native) inside.native = m.native;
    if (m.opfs) inside.opfs = m.opfs;
    if (m.thumb) inside.thumb = { b: new Uint8Array(await m.thumb.arrayBuffer()), t: m.thumb.type };
    let lockedBlob: Blob | undefined;
    const fk = (m as ChatMessage & { fk?: Uint8Array }).fk;
    if (keepBlob && fk) {
      inside.fk = fk;
      lockedBlob = keepBlob;
    } else if (m.blob) {
      const s = await sealBytes(new Uint8Array(await m.blob.arrayBuffer()));
      inside.fk = s.fk;
      lockedBlob = new Blob([s.sealed as Uint8Array<ArrayBuffer>]);
    }
    const out: ChatMessage = { peer: m.peer, from: m.from, text: '', ts: m.ts, mid: m.mid, locked: await seal(pub, m.peer, inside) };
    if (m.key !== undefined) out.key = m.key;
    if (m.st) out.st = m.st; // ticks stay outside the seal (they say nothing about the content)
    if (m.rc) out.rc = m.rc;
    if (m.note) out.note = true;
    if (lockedBlob) out.lockedBlob = lockedBlob;
    if (m.native) out.keepRef = m.native.ref;
    return out;
  }

  /** `keepFk`: leave the file sealed and return its key on the message (for changeCode). */
  private async openWith(o: OpenLock, m: ChatMessage, keepFk = false): Promise<ChatMessage> {
    if (!isBox(m.locked)) return m;
    const inside = await unseal<Inside>(o, m.peer, m.locked);
    const out: ChatMessage & { fk?: Uint8Array } = { peer: m.peer, from: m.from, text: inside.text ?? '', ts: m.ts, mid: m.mid };
    if (m.key !== undefined) out.key = m.key;
    if (m.st) out.st = m.st;
    if (m.rc) out.rc = m.rc;
    if (m.note) out.note = true;
    if (inside.fromName) out.fromName = inside.fromName;
    if (inside.fromId) out.fromId = inside.fromId;
    if (inside.file) out.file = inside.file;
    if (inside.native) out.native = inside.native;
    if (inside.opfs) out.opfs = inside.opfs;
    if (inside.thumb) out.thumb = new Blob([inside.thumb.b as Uint8Array<ArrayBuffer>], { type: inside.thumb.t });
    if (inside.fk && m.lockedBlob) {
      if (keepFk) out.fk = inside.fk;
      else out.blob = new Blob([(await openBytes(inside.fk, new Uint8Array(await m.lockedBlob.arrayBuffer()))) as Uint8Array<ArrayBuffer>], { type: inside.file?.type ?? '' });
    }
    return out;
  }
}
