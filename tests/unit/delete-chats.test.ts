// Delete and remove options in the lists (design approved 23 Oct 2026): Clear chat, Delete chat,
// Delete group (after leaving), and how a call's end is said in the chat. Everything is on this device.
import { describe, expect, it } from 'vitest';
import { toB64url } from '../../src/core/bytes';
import { newGuestIdentity, p2pId } from '../../src/core/identity';
import { ChatLocks, type LockStorage } from '../../src/core/locks';
import { clearChatData, filesOf } from '../../src/core/forget';
import type { LockRecord } from '../../src/core/chatlock';
import type { ChatMessage } from '../../src/core/store';
import { GroupManager, type GroupMember } from '../../src/net/groups';
import { endText } from '../../src/ui/call';
import { memPair, sleep } from './memlink';

const FAST = { m: 256, t: 1, p: 1 };

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
  return { st, msgs, lock: () => lock };
}

const msg = (peer: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ peer, from: 'them', text: 'hi', ts: Date.now(), mid: Math.random().toString(36).slice(2), ...extra });

describe('Clear chat / Delete chat: the chat’s received files', () => {
  it('finds the app’s received files (also a locked message’s keepRef) and the browser’s private files', () => {
    const f = filesOf(
      [msg('a', { native: { ref: 'r1', name: 'x.jpg', size: 1, mime: 'image/jpeg' } }), msg('a', { keepRef: 'r2', locked: {} as never }), msg('a', { opfs: 'o1-x.pdf' }), msg('a', { text: 'plain' })],
      [msg('a', { opfs: 'o2-sealed.mov' }), msg('a', { native: { ref: 'r2', name: 'y', size: 1, mime: '' } })],
    );
    expect(f.native.sort()).toEqual(['r1', 'r2']);
    expect(f.opfs.sort()).toEqual(['o1-x.pdf', 'o2-sealed.mov']);
  });

  it('deletes the messages first, then the files; a file another chat still shows stays; a file that can’t go is skipped', async () => {
    const order: string[] = [];
    const stored = [msg('a', { native: { ref: 'r1', name: 'a', size: 1, mime: '' } }), msg('a', { native: { ref: 'shared', name: 'b', size: 1, mime: '' } }), msg('a', { opfs: 'o1' }), msg('a', { opfs: 'gone' })];
    const n = await clearChatData('a', {
      stored: async () => stored,
      opened: async () => null,
      deleteMessages: async (chat) => void order.push(`messages:${chat}`),
      removeNative: async (ref) => void order.push(`native:${ref}`),
      removeOpfs: async (name) => {
        if (name === 'gone') throw new Error('not there');
        order.push(`opfs:${name}`);
      },
      inUseElsewhere: async () => ({ native: ['shared'], opfs: [] }),
    });
    expect(order).toEqual(['messages:a', 'native:r1', 'opfs:o1']);
    expect(n).toBe(2);
  });

  it('a locked chat: the sealed file names are read with the chat open; without the code only keepRef is known', async () => {
    const stored = [msg('a', { locked: {} as never, keepRef: 'r9' })];
    const removed: string[] = [];
    const deps = {
      stored: async () => stored,
      deleteMessages: async () => undefined,
      removeNative: async (r: string) => void removed.push(r),
      removeOpfs: async (o: string) => void removed.push(o),
    };
    await clearChatData('a', { ...deps, opened: async () => [msg('a', { opfs: 'o-secret.jpg' })] });
    expect(removed.sort()).toEqual(['o-secret.jpg', 'r9']);
    removed.length = 0;
    await clearChatData('a', { ...deps, opened: async () => null });
    expect(removed).toEqual(['r9']);
  });
});

describe('Delete a locked chat', () => {
  it('drops its sealed messages and takes it out of the lock; other locked chats stay locked', async () => {
    const m = memoryStore();
    const L = new ChatLocks(m.st, FAST);
    await L.load();
    await L.setCode('2580');
    await L.store(msg('ravi', { text: 'a secret' }));
    await L.store(msg('meera', { text: 'another' }));
    await L.lock('ravi');
    await L.lock('meera');
    expect([...m.msgs.values()].every((x) => x.locked && x.text === '')).toBe(true);
    await L.dropChat('ravi'); // no code needed: nothing is shown
    expect(L.isLocked('ravi')).toBe(false);
    expect(L.isLocked('meera')).toBe(true);
    expect([...m.msgs.values()].map((x) => x.peer)).toEqual(['meera']);
    expect(m.lock()?.chats).toEqual(['meera']);
    // A new chat with the same person later is not locked by itself.
    await L.store(msg('ravi', { text: 'new' }));
    expect([...m.msgs.values()].find((x) => x.peer === 'ravi')?.text).toBe('new');
  });
});

function person(name: string) {
  const ident = newGuestIdentity();
  const me = { ...ident, name };
  const gm = new GroupManager(me);
  const member: GroupMember = { p2pId: p2pId(ident.publicKey), identityKey: toB64url(ident.publicKey), name };
  return { gm, member, id: member.p2pId };
}

async function settle(...gms: GroupManager[]): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await sleep(2);
    await Promise.all(gms.map((g) => g.idle()));
  }
}

describe('Leave group, then Delete group', () => {
  it('only a group I left can be deleted; it is forgotten (also after a restart); an admin adding me again is a new invite', async () => {
    const A = person('A');
    const B = person('B');
    const C = person('C');
    for (const p of [B, C]) p.gm.on('invite', (g) => void p.gm.acceptInvite(g.id));
    const link = (x: ReturnType<typeof person>, y: ReturnType<typeof person>) => {
      const pair = memPair(y.id, x.id);
      x.gm.attach(pair.a);
      y.gm.attach(pair.b);
    };
    link(A, B);
    link(A, C);
    link(B, C);
    const gid = await A.gm.create('Seva team', [B.member, C.member]);
    await settle(A.gm, B.gm, C.gm);
    expect(B.gm.get(gid)?.status).toBe('joined');
    expect(await B.gm.forget(gid)).toBe(false); // still in it: Leave first
    await B.gm.leave(gid);
    await settle(A.gm, B.gm, C.gm);
    expect(B.gm.get(gid)?.status).toBe('left');
    expect(A.gm.get(gid)?.members.map((m) => m.name).sort()).toEqual(['A', 'C']);
    expect(await B.gm.forget(gid)).toBe(true);
    expect(B.gm.get(gid)).toBeUndefined();
    const saved = JSON.parse(JSON.stringify(B.gm.exportState()));
    expect(saved.groups.some((g: { rec: { id: string } }) => g.rec.id === gid)).toBe(false);
    // Messages in the group no longer reach B, and nothing for it is kept.
    await A.gm.send(gid, { text: 'after B left' });
    await settle(A.gm, B.gm, C.gm);
    expect(B.gm.get(gid)).toBeUndefined();
    // An admin adds B again: it comes back as an invite (B chooses).
    let invited = 0;
    B.gm.on('invite', () => invited++);
    await A.gm.addMembers(gid, [B.member]);
    await settle(A.gm, B.gm, C.gm);
    expect(invited).toBe(1); // an invite again (here the test's handler then joins it)
    expect(B.gm.get(gid)?.status).toBe('joined');
  });
});

describe('A call’s end, said in the chat', () => {
  const base = { video: false, outgoing: true, failure: undefined, connectedAt: undefined } as const;
  it('plain words for each ending', () => {
    const now = 1_000_000;
    expect(endText('Ravi', { ...base, state: 'ended', connectedAt: now - 4 * 60_000 }, now)).toBe('Voice call · 4 min');
    expect(endText('Ravi', { ...base, state: 'ended', video: true, connectedAt: now - 5_000 }, now)).toBe('Video call · 1 min');
    expect(endText('Ravi', { ...base, state: 'missed', outgoing: false })).toBe('Missed voice call');
    expect(endText('Ravi', { ...base, state: 'failed', failure: 'declined' })).toBe('Voice call · Ravi declined');
    expect(endText('Ravi', { ...base, state: 'failed', failure: 'no-answer' })).toBe('Voice call · Ravi didn’t answer');
    expect(endText('Ravi', { ...base, state: 'failed', failure: 'my-media' })).toBe("Voice call · Your camera or microphone isn't available");
    expect(endText('Ravi', { ...base, state: 'ended', outgoing: false })).toBe('Voice call · declined');
  });
});
