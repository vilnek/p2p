// Chat lock (plan §8.7, security review I-1): key derivation, seal / open, wrong codes, change code.
import { argon2idAsync } from '@noble/hashes/argon2';
import { describe, expect, it } from 'vitest';
import { fromUtf8, utf8 } from '../../src/core/bytes';
import { ARGON2, argon2, codeProblem, newLock, openLock, seal, unseal, waitAfter, WrongCode, type LockRecord } from '../../src/core/chatlock';
import { ChatLocks, type LockStorage } from '../../src/core/locks';
import type { ChatMessage } from '../../src/core/store';

const FAST = { m: 256, t: 1, p: 1 }; // tests only; the app uses ARGON2 (64 MiB, t = 3)
const secret = () => crypto.getRandomValues(new Uint8Array(32));

/** The store, in memory (what IndexedDB does in the app). */
function memoryStore() {
  let key = 0;
  const msgs = new Map<number, ChatMessage>();
  let lock: LockRecord | undefined;
  let sec: Uint8Array | undefined;
  let tries = { fails: 0, until: 0 };
  const st: LockStorage = {
    loadLock: async () => lock,
    loadSecret: async () => sec,
    saveSecret: async (b) => void (sec = b),
    loadTries: async () => tries,
    saveTries: async (t) => void (tries = t),
    messages: async (chat) => [...msgs.values()].filter((m) => m.peer === chat).map((m) => ({ ...m })),
    add: async (m) => {
      const k = ++key;
      msgs.set(k, { ...m, key: k });
      return k;
    },
    commit: async (put, del, l) => {
      for (const [k, m] of msgs) if (del.includes(m.peer)) msgs.delete(k);
      for (const m of put) msgs.set(m.key!, m);
      lock = l ?? undefined;
    },
  };
  return { st, msgs, raw: () => [...msgs.values()] };
}

describe('chat lock: key derivation', () => {
  it('uses the review’s Argon2id parameters (64 MiB, t = 3, p = 1)', () => {
    expect(ARGON2).toEqual({ m: 65536, t: 3, p: 1 });
  });

  it('WebAssembly and plain JavaScript Argon2id give the same key (the fallback reads the same locks)', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const a = await argon2('2580', salt, { m: 1024, t: 2, p: 1 });
    const b = await argon2idAsync(utf8('2580'), salt, { m: 1024, t: 2, p: 1, dkLen: 32 });
    expect(a).toEqual(b);
    expect(a.length).toBe(32);
  });

  it('the full parameters run (a real lock) and only the right code with this device’s secret opens it', async () => {
    const dev = secret();
    const { record } = await newLock('2580', dev, ['111'], ARGON2);
    expect(record.params).toEqual(ARGON2);
    expect(record.salt.length).toBe(16);
    await expect(openLock(record, '2580', dev)).resolves.toBeTruthy();
    await expect(openLock(record, '2581', dev)).rejects.toBeInstanceOf(WrongCode);
    await expect(openLock(record, '2580', secret())).rejects.toBeInstanceOf(WrongCode); // a copy without the device secret
  }, 30_000);

  it('codes: at least 4 digits, or a passphrase of 6+', () => {
    expect(codeProblem('123')).toBeTruthy();
    expect(codeProblem('1234')).toBeNull();
    expect(codeProblem('abcde')).toBeTruthy();
    expect(codeProblem('seva ok')).toBeNull();
  });

  it('wrong codes wait longer each time (no wipe)', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(waitAfter)).toEqual([1, 2, 5, 10, 30, 60, 300, 300]);
  });
});

describe('chat lock: sealing messages', () => {
  it('seals with the public key only; opens with the code; bound to its chat', async () => {
    const dev = secret();
    const { record } = await newLock('2580', dev, [], FAST);
    const box = await seal(record.pub, '111', { text: 'namaste', b: utf8('x') });
    expect(fromUtf8(box.ct)).not.toContain('namaste');
    const open = await openLock(record, '2580', dev);
    expect(await unseal(open, '111', box)).toEqual({ text: 'namaste', b: utf8('x') });
    await expect(unseal(open, '222', box)).rejects.toBeInstanceOf(WrongCode); // moved to another chat
    const bad = { ...box, ct: box.ct.slice() };
    bad.ct[0] ^= 1;
    await expect(unseal(open, '111', bad)).rejects.toBeInstanceOf(WrongCode);
  });

  it('lock a chat: old and new messages are stored sealed; read needs the code', async () => {
    const { st, raw } = memoryStore();
    let now = 1_000_000;
    const L = new ChatLocks(st, FAST, () => now);
    await L.load();
    await L.store({ peer: '111', from: 'them', text: 'before the lock', ts: 1, mid: 'a' });
    await L.store({ peer: '222', from: 'them', text: 'another chat', ts: 2, mid: 'b' });
    await L.setCode('2580');
    await L.lock('111');
    await L.store({ peer: '111', from: 'me', text: 'after the lock', ts: 3, mid: 'c', fromName: 'Ravi', blob: new Blob(['photo bytes']), file: { name: 'p.jpg', size: 11, type: 'image/jpeg' } });
    const stored = raw().filter((m) => m.peer === '111');
    expect(stored).toHaveLength(2);
    for (const m of stored) {
      expect(m.text).toBe('');
      expect(m.locked).toBeTruthy();
      expect(m.blob).toBeUndefined();
      expect(m.file).toBeUndefined();
      expect(JSON.stringify(m)).not.toMatch(/before the|after the|Ravi|p\.jpg/);
    }
    expect(fromUtf8(new Uint8Array(await stored[1].lockedBlob!.arrayBuffer()))).not.toContain('photo');
    expect(raw().find((m) => m.peer === '222')!.text).toBe('another chat'); // other chats untouched
    expect(await L.read('111')).toBeNull();

    // Wrong code: a wait, and even the right code is refused until it ends.
    expect(await L.unlock('0000')).toEqual({ ok: false, wait: 1 });
    expect((await L.unlock('2580')).ok).toBe(false);
    now += 1000;
    expect(await L.unlock('2580')).toEqual({ ok: true, wait: 0 });
    const back = (await L.read('111'))!;
    expect(back.map((m) => m.text)).toEqual(['before the lock', 'after the lock']);
    expect(back[1].fromName).toBe('Ravi');
    expect(await back[1].blob!.text()).toBe('photo bytes');
    L.close();
    expect(await L.read('111')).toBeNull();
  });

  it('a wrong code after a reload still waits (the tries are stored)', async () => {
    const { st } = memoryStore();
    const now = 5_000_000;
    const A = new ChatLocks(st, FAST, () => now);
    await A.load();
    await A.setCode('2580');
    await A.unlock('1');
    await A.unlock('2'); // still waiting: not counted
    const B = new ChatLocks(st, FAST, () => now);
    await B.load();
    expect(await B.waitLeft()).toBe(1);
  });

  it('change code re-seals: the old code opens nothing, the new one opens everything', async () => {
    const { st, raw } = memoryStore();
    let now = 0;
    const L = new ChatLocks(st, FAST, () => now);
    await L.load();
    await L.setCode('2580');
    await L.store({ peer: 'g:abc', from: 'them', text: 'group hello', ts: 1, mid: 'a', fromName: 'Asha' });
    await L.lock('g:abc');
    await L.store({ peer: 'g:abc', from: 'them', text: 'file', ts: 2, mid: 'b', blob: new Blob(['data']), file: { name: 'a.bin', size: 4, type: '' } });
    const before = raw().map((m) => m.locked!.ct);
    expect(await L.changeCode('9999', 'new pass')).toEqual({ ok: false, wait: 1 });
    now += 1000;
    expect(await L.changeCode('2580', 'new pass')).toEqual({ ok: true, wait: 0 });
    const after = raw();
    after.forEach((m, i) => expect(m.locked!.ct).not.toEqual(before[i]));
    now += 10_000;
    expect((await L.unlock('2580')).ok).toBe(false);
    now += 10_000;
    expect((await L.unlock('new pass')).ok).toBe(true);
    const back = (await L.read('g:abc'))!;
    expect(back.map((m) => m.text)).toEqual(['group hello', 'file']);
    expect(await back[1].blob!.text()).toBe('data');
  });

  it('remove the lock from a chat, and "forgot code" deletes only the locked chats’ messages', async () => {
    const { st, raw } = memoryStore();
    const L = new ChatLocks(st, FAST);
    await L.load();
    await L.setCode('2580');
    await L.store({ peer: '111', from: 'them', text: 'one', ts: 1, mid: 'a' });
    await L.store({ peer: '222', from: 'them', text: 'two', ts: 2, mid: 'b' });
    await L.store({ peer: '333', from: 'them', text: 'three', ts: 3, mid: 'c' });
    await L.lock('111');
    await L.lock('222');
    await L.unlock('2580');
    await L.unlockChat('222');
    expect(raw().find((m) => m.peer === '222')!.text).toBe('two');
    expect(L.isLocked('222')).toBe(false);
    L.close();
    expect(await L.forget()).toEqual(['111']);
    expect(raw().map((m) => m.peer).sort()).toEqual(['222', '333']);
    expect(L.isSet).toBe(false);
  });
});
