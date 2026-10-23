import { describe, expect, it } from 'vitest';
import { toB64url } from '../../src/core/bytes';
import type { Channel, Frame } from '../../src/core/channel';
import { newGuestIdentity, p2pId } from '../../src/core/identity';
import {
  GroupManager,
  checkNext,
  openGroupMessage,
  recordHash,
  signRecord,
  type GroupFrame,
  type GroupMember,
  type GroupMessage,
  type GroupOptions,
  type GroupRecord,
  type GroupsState,
} from '../../src/net/groups';
import { memPair, sleep, type MemPair } from './memlink';

interface Person {
  name: string;
  id: string;
  me: { secretKey: Uint8Array; publicKey: Uint8Array; name: string };
  gm: GroupManager;
  member: GroupMember;
  got: GroupMessage[];
}

function world(...names: string[]) {
  return worldWith({}, ...names);
}

function worldWith(opts: GroupOptions, ...names: string[]) {
  const people: Record<string, Person> = {};
  for (const name of names) {
    const ident = newGuestIdentity();
    const me = { ...ident, name };
    const id = p2pId(ident.publicKey);
    const gm = new GroupManager(me, opts);
    const p: Person = { name, id, me, gm, member: { p2pId: id, identityKey: toB64url(ident.publicKey), name }, got: [] };
    gm.on('message', (m) => p.got.push(m));
    people[name] = p;
  }
  const links = new Map<string, { pair: MemPair; off: () => void }>();
  const key = (a: Person, b: Person) => [a.id, b.id].sort().join('|');
  const connect = (a: Person, b: Person) => {
    if (links.has(key(a, b))) return;
    const pair = memPair(b.id, a.id);
    const da = a.gm.attach(pair.a);
    const db = b.gm.attach(pair.b);
    links.set(key(a, b), {
      pair,
      off: () => {
        pair.close();
        da();
        db();
      },
    });
  };
  const disconnect = (a: Person, b: Person) => {
    links.get(key(a, b))?.off();
    links.delete(key(a, b));
  };
  const all = Object.values(people);
  const mesh = () => all.forEach((a, i) => all.slice(i + 1).forEach((b) => connect(a, b)));
  const isolate = () => [...links.keys()].forEach((k) => (links.get(k)!.off(), links.delete(k)));
  const settle = async (rounds = 25) => {
    for (let i = 0; i < rounds; i++) {
      await sleep(2);
      await Promise.all(all.map((p) => p.gm.idle()));
    }
  };
  const acceptInvites = () => all.forEach((p) => p.gm.on('invite', (g) => void p.gm.acceptInvite(g.id)));
  return { ...people, people: all, connect, disconnect, mesh, isolate, settle, acceptInvites } as Record<string, Person> & {
    people: Person[];
    connect: typeof connect;
    disconnect: typeof disconnect;
    mesh: () => void;
    isolate: () => void;
    settle: (r?: number) => Promise<void>;
    acceptInvites: () => void;
  };
}

/** A channel that only records what is sent on it (to replay frames in any order). */
function tap(peerId: string): Channel & { frames: Frame[] } {
  const frames: Frame[] = [];
  return { peerId, frames, send: async (f) => void frames.push(JSON.parse(JSON.stringify(f))), onFrame: () => () => undefined };
}

const texts = (p: Person, gid?: string) => p.got.filter((m) => !gid || m.gid === gid).map((m) => (m.body as { text: string }).text);

describe('groups: create, add, remove, rotate, send, receive', () => {
  it('create, join, send and receive', async () => {
    const w = world('A', 'B', 'C');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('Seva team', [w.B.member, w.C.member]);
    await w.settle();
    expect(w.B.gm.get(gid)).toMatchObject({ name: 'Seva team', status: 'joined', epoch: 0, iAmAdmin: false });
    await w.A.gm.send(gid, { text: 'namaste' });
    await w.B.gm.send(gid, { text: 'hello from B' });
    await w.settle();
    expect(texts(w.B)).toEqual(['namaste']);
    expect(texts(w.C).sort()).toEqual(['hello from B', 'namaste']);
    expect(texts(w.A)).toEqual(['hello from B']);
    expect(w.C.got.find((m) => m.from === w.A.id)?.fromName).toBe('A');
  });

  it('add a member: they read new messages, not old ones', async () => {
    const w = world('A', 'B', 'D');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('G', [w.B.member]);
    await w.settle();
    await w.A.gm.send(gid, { text: 'before D' });
    await w.settle();
    await w.A.gm.addMembers(gid, [w.D.member]);
    await w.settle();
    expect(w.D.gm.get(gid)).toMatchObject({ status: 'joined', epoch: 1 });
    await w.B.gm.send(gid, { text: 'after D' });
    await w.settle();
    expect(texts(w.D)).toEqual(['after D']);
    expect(texts(w.A)).toEqual(['after D']);
  });

  it('remove a member: keys rotate and they cannot read new messages', async () => {
    const w = world('A', 'B', 'C');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('G', [w.B.member, w.C.member]);
    await w.settle();
    const cOldKeys = w.C.gm.exportState().groups[0].keys.map(([, k]) => k);
    const bKeysBefore = new Set(w.B.gm.exportState().groups[0].keys.map(([, k]) => k));
    const removed: string[] = [];
    w.C.gm.on('removed', (g) => removed.push(g.id));

    // Catch the next message frame that reaches B, to try it on C.
    const frames: GroupFrame[] = [];
    const orig = w.B.gm.onFrame.bind(w.B.gm);
    w.B.gm.onFrame = (from, f) => {
      if ((f as GroupFrame).k === 'g-msg') frames.push(f as GroupFrame);
      orig(from, f);
    };
    await w.A.gm.removeMembers(gid, [w.C.id]);
    await w.settle();
    expect(removed).toEqual([gid]);
    expect(w.C.gm.get(gid)?.status).toBe('removed');
    expect(w.A.gm.get(gid)?.epoch).toBe(1);
    // New keys for epoch 1, different from every key of epoch 0.
    const bAfter = w.B.gm.exportState().groups[0].keys.filter(([id]) => id.startsWith('1|'));
    expect(bAfter.length).toBe(2); // A's and B's own
    for (const [, k] of bAfter) expect(bKeysBefore.has(k)).toBe(false);

    await w.A.gm.send(gid, { text: 'secret plan' });
    await w.settle();
    expect(texts(w.B)).toEqual(['secret plan']);
    expect(texts(w.C)).toEqual([]);
    // Even with the frame in hand, none of C's old keys open it.
    const f = frames.find((x) => x.k === 'g-msg')! as Extract<GroupFrame, { k: 'g-msg' }>;
    w.C.gm.onFrame(w.A.id, f);
    await w.settle(3);
    expect(texts(w.C)).toEqual([]);
    const { fromB64url } = await import('../../src/core/bytes');
    for (const k of cOldKeys) await expect(openGroupMessage(fromB64url(k), f)).rejects.toThrow();
    // And C can't send to the group any more.
    await expect(w.C.gm.send(gid, { text: 'still here?' })).rejects.toThrow();
  });

  it('leave: an admin removes the member who left', async () => {
    const w = world('A', 'B', 'C');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('G', [w.B.member, w.C.member]);
    await w.settle();
    await w.C.gm.leave(gid);
    await w.settle();
    expect(w.C.gm.get(gid)?.status).toBe('left');
    expect(w.A.gm.get(gid)?.members.map((m) => m.name).sort()).toEqual(['A', 'B']);
    expect(w.B.gm.get(gid)?.epoch).toBe(1);
  });

  it('decline an invite: removed by the admin', async () => {
    const w = world('A', 'B');
    w.B.gm.on('invite', (g) => void w.B.gm.declineInvite(g.id));
    w.A.gm.on('invite', () => undefined);
    w.mesh();
    const gid = await w.A.gm.create('G', [w.B.member]);
    await w.settle();
    expect(w.A.gm.get(gid)?.members.map((m) => m.name)).toEqual(['A']);
  });

  it('admin actions: rename and make admin; a non-admin cannot change the group', async () => {
    const w = world('A', 'B', 'C');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('G', [w.B.member, w.C.member]);
    await w.settle();
    await expect(w.B.gm.rename(gid, 'Mine now')).rejects.toThrow(/Only admins/);
    await w.A.gm.setAdmin(gid, w.B.id, true);
    await w.settle();
    await w.B.gm.rename(gid, 'Seva 2');
    await w.settle();
    for (const p of w.people) expect(p.gm.get(gid)).toMatchObject({ name: 'Seva 2', epoch: 2 });
    expect(w.C.gm.get(gid)?.admins.sort()).toEqual([w.A.id, w.B.id].sort());
  });
});

describe('groups: forged changes', () => {
  it('rejects a change signed by a non-admin, a changed record and a removed admin', async () => {
    const w = world('A', 'B', 'C');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('G', [w.B.member, w.C.member]);
    await w.settle();
    const cur = w.C.gm.record(gid)!;

    // B (not an admin) makes itself admin and signs it.
    const forged = signRecord(w.B.me, { ...cur, admins: [w.A.id, w.B.id], epoch: 1, prev: recordHash(cur), ts: Date.now() });
    expect(checkNext(cur, forged)).toBe(false);
    w.C.gm.onFrame(w.B.id, { k: 'g-rec', gid, recs: [forged] });
    await w.settle(3);
    expect(w.C.gm.get(gid)).toMatchObject({ epoch: 0, admins: [w.A.id] });

    // A real change by A, then changed on the way (new name, same signature).
    await w.A.gm.rename(gid, 'Real');
    await w.settle();
    const real = w.A.gm.record(gid)!;
    const tampered: GroupRecord = { ...real, name: 'Fake', epoch: 2, prev: recordHash(real) };
    w.C.gm.onFrame(w.A.id, { k: 'g-rec', gid, recs: [tampered] });
    await w.settle(3);
    expect(w.C.gm.get(gid)).toMatchObject({ epoch: 1, name: 'Real' });

    // A makes B admin, then removes B's admin role; B's later change is refused.
    await w.A.gm.setAdmin(gid, w.B.id, true);
    await w.settle();
    await w.A.gm.setAdmin(gid, w.B.id, false);
    await w.settle();
    const now = w.C.gm.record(gid)!;
    const late = signRecord(w.B.me, { ...now, name: 'B was here', epoch: now.epoch + 1, prev: recordHash(now), ts: Date.now() });
    w.C.gm.onFrame(w.B.id, { k: 'g-rec', gid, recs: [late] });
    await w.settle(3);
    expect(w.C.gm.get(gid)?.name).toBe('Real');

    // A message claiming to be from A but signed by B is dropped.
    const before = w.C.got.length;
    w.C.gm.onFrame(w.B.id, { k: 'g-msg', gid, epoch: now.epoch, mid: 'AAAAAAAAAAAA', from: w.A.id, ts: 1, ct: 'AAAA', sig: 'A'.repeat(86) });
    await w.settle(3);
    expect(w.C.got.length).toBe(before);
  });
});

describe('groups: relay, dedupe and hops', () => {
  it('a member the sender cannot reach gets it through another member, once', async () => {
    const w = world('A', 'B', 'C');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('G', [w.B.member, w.C.member]);
    await w.settle();
    w.disconnect(w.A, w.C); // A and C can't reach each other; B reaches both
    const r = await w.A.gm.send(gid, { text: 'via B' });
    expect(r).toMatchObject({ direct: 1, waiting: 1 });
    await w.settle();
    expect(texts(w.C)).toEqual(['via B']);
    // Reconnecting A and C: A also kept it for C, but C has it already (no second copy).
    w.connect(w.A, w.C);
    await w.settle();
    expect(texts(w.C)).toEqual(['via B']);
  });

  it('a member who was offline gets it when they come back (store and forward)', async () => {
    const w = world('A', 'B', 'C', 'D');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('G', [w.B.member, w.C.member, w.D.member]);
    await w.settle();
    for (const p of [w.A, w.B, w.C]) w.disconnect(p, w.D);
    await w.A.gm.send(gid, { text: 'while D was away' });
    await w.settle();
    expect(texts(w.D)).toEqual([]);
    w.connect(w.C, w.D); // D comes back and meets only C
    await w.settle();
    expect(texts(w.D)).toEqual(['while D was away']);
    w.connect(w.B, w.D);
    w.connect(w.A, w.D);
    await w.settle();
    expect(texts(w.D)).toEqual(['while D was away']); // still once
  });

  it('stops after 2 hops', async () => {
    const w = world('A', 'B', 'C', 'D', 'E');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('Chain', [w.B.member, w.C.member, w.D.member, w.E.member]);
    await w.settle();
    w.isolate();
    // A - B - C - D - E, each only meets the next one.
    w.connect(w.A, w.B);
    w.connect(w.B, w.C);
    w.connect(w.C, w.D);
    w.connect(w.D, w.E);
    await w.settle();
    await w.A.gm.send(gid, { text: 'down the line' });
    await w.settle();
    expect(texts(w.B)).toEqual(['down the line']); // direct
    expect(texts(w.C)).toEqual(['down the line']); // 1 hop
    expect(texts(w.D)).toEqual(['down the line']); // 2 hops
    expect(texts(w.E)).toEqual([]); // would be 3
  });

  it('the same message arriving twice is shown once', async () => {
    const w = world('A', 'B');
    w.acceptInvites();
    const frames: Frame[] = [];
    w.mesh();
    const gid = await w.A.gm.create('G', [w.B.member]);
    await w.settle();
    const t = tap(w.B.id);
    w.A.gm.attach(t);
    await w.A.gm.send(gid, { text: 'once' });
    frames.push(...t.frames.filter((f) => (f as GroupFrame).k === 'g-msg'));
    expect(frames.length).toBe(1);
    w.B.gm.onFrame(w.A.id, frames[0]);
    w.B.gm.onFrame(w.A.id, frames[0]);
    await w.settle(3);
    expect(texts(w.B)).toEqual(['once']);
  });
});

describe('groups: epochs out of order', () => {
  it('a message and records from newer epochs that arrive early wait, then open', async () => {
    const w = world('A', 'B', 'C');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('G', [w.B.member, w.C.member]);
    await w.settle();
    // From here on, what A sends to C is caught and handed to C in reverse order.
    w.disconnect(w.A, w.C);
    w.disconnect(w.B, w.C);
    const t = tap(w.C.id);
    w.A.gm.attach(t);
    await w.A.gm.rename(gid, 'One');
    await w.A.gm.rename(gid, 'Two');
    await w.A.gm.send(gid, { text: 'epoch 2' });
    await w.settle();
    const kinds = t.frames.map((f) => (f as GroupFrame).k);
    expect(kinds).toContain('g-msg');
    for (const f of [...t.frames].reverse()) w.C.gm.onFrame(w.A.id, f);
    await w.settle();
    expect(w.C.gm.get(gid)).toMatchObject({ epoch: 2, name: 'Two' });
    expect(texts(w.C)).toEqual(['epoch 2']);
  });

  it('a late message from the epoch just before still opens', async () => {
    const w = world('A', 'B', 'C');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('G', [w.B.member, w.C.member]);
    await w.settle();
    const t = tap(w.C.id);
    w.B.gm.attach(t);
    await w.B.gm.send(gid, { text: 'sent at epoch 0' });
    const late = t.frames.find((f) => (f as GroupFrame).k === 'g-msg')!;
    w.disconnect(w.B, w.C);
    w.connect(w.B, w.C);
    await w.A.gm.rename(gid, 'Moved on');
    await w.settle();
    expect(w.C.gm.get(gid)?.epoch).toBe(1);
    w.C.gm.onFrame(w.B.id, late);
    await w.settle(3);
    expect(texts(w.C)).toEqual(['sent at epoch 0']);
  });

  it('two admins changing at once: everyone ends on the same record', async () => {
    const w = world('A', 'B', 'C');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('G', [w.B.member, w.C.member]);
    await w.settle();
    await w.A.gm.setAdmin(gid, w.B.id, true);
    await w.settle();
    const conflicts: string[] = [];
    for (const p of w.people) p.gm.on('conflict', () => conflicts.push(p.name));
    w.isolate();
    await w.A.gm.rename(gid, 'Name by A');
    await w.B.gm.rename(gid, 'Name by B');
    w.mesh();
    await w.settle(40);
    const hashes = w.people.map((p) => recordHash(p.gm.record(gid)!));
    expect(new Set(hashes).size).toBe(1);
    expect(w.C.gm.get(gid)?.epoch).toBe(2);
    expect(conflicts.length).toBe(1); // the admin whose change lost is told
    await w.C.gm.send(gid, { text: 'after the clash' });
    await w.A.gm.send(gid, { text: 'from A' });
    await w.settle();
    expect(texts(w.A)).toEqual(['after the clash']);
    expect(texts(w.B).sort()).toEqual(['after the clash', 'from A']);
  });
});

describe('groups: saved state', () => {
  it('export and import: a restarted member still reads the group', async () => {
    const w = world('A', 'B');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('G', [w.B.member]);
    await w.settle();
    const saved = JSON.parse(JSON.stringify(w.B.gm.exportState()));
    const B2 = new GroupManager(w.B.me);
    B2.importState(saved);
    const got: GroupMessage[] = [];
    B2.on('message', (m) => got.push(m));
    w.disconnect(w.A, w.B);
    const pair = memPair(w.A.id, w.B.id);
    w.A.gm.attach(pair.b);
    B2.attach(pair.a);
    await w.A.gm.send(gid, { text: 'after restart' });
    await w.settle();
    await B2.idle();
    expect(got.map((m) => (m.body as { text: string }).text)).toEqual(['after restart']);
    expect(B2.get(gid)?.status).toBe('joined');
  });
});

describe('groups: catching up after being away (BUG-6)', () => {
  /** A channel that looks open but loses everything (a member who just closed the app). */
  const dead = (peerId: string): Channel => ({ peerId, send: async () => undefined, onFrame: () => () => undefined });
  const restarted = (p: Person, saved: GroupsState) => {
    const gm = new GroupManager(p.me);
    const got: GroupMessage[] = [];
    gm.on('message', (m) => got.push(m));
    return { gm, got, texts: () => got.map((m) => (m.body as { text: string }).text), saved: JSON.parse(JSON.stringify(saved)) as GroupsState };
  };
  const keptFor = (gm: GroupManager, id: string) => (gm.exportState().kept ?? []).filter((k) => k.targets.includes(id)).length;

  it('a member whose connection still looked open when the messages were sent gets them when they reconnect', async () => {
    const w = world('A', 'B', 'C');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('Catch', [w.B.member, w.C.member]);
    await w.settle();
    // C closes the app: A and B still think the link is open for a while; everything sent is lost.
    w.disconnect(w.A, w.C);
    w.disconnect(w.B, w.C);
    const offA = w.A.gm.attach(dead(w.C.id));
    const offB = w.B.gm.attach(dead(w.C.id));
    await w.A.gm.send(gid, { text: 'missed one' });
    await w.A.gm.send(gid, { text: 'missed two' });
    await w.settle();
    expect(texts(w.C)).toEqual([]);
    expect(keptFor(w.A.gm, w.C.id)).toBe(2);
    expect(keptFor(w.A.gm, w.B.id)).toBe(0); // B said it has them
    offA();
    offB();
    w.connect(w.A, w.C); // C is back and connects to the admin only
    await w.settle();
    expect(texts(w.C)).toEqual(['missed one', 'missed two']);
    expect(keptFor(w.A.gm, w.C.id)).toBe(0);
    w.connect(w.B, w.C);
    await w.settle();
    expect(texts(w.C)).toEqual(['missed one', 'missed two']); // once
  });

  it('a member who restarts and connects before their groups are loaded still gets them', async () => {
    const w = world('A', 'C');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('Catch', [w.C.member]);
    await w.settle();
    const c = restarted(w.C, w.C.gm.exportState());
    w.disconnect(w.A, w.C);
    await w.A.gm.send(gid, { text: 'while away' });
    await w.settle();
    // The app connects first, and loads its saved groups a moment later.
    const pair = memPair(w.A.id, w.C.id);
    w.A.gm.attach(pair.b);
    c.gm.attach(pair.a);
    await w.settle();
    await c.gm.idle();
    expect(c.texts()).toEqual([]);
    c.gm.importState(c.saved);
    for (let i = 0; i < 25; i++) {
      await sleep(4);
      await Promise.all([w.A.gm.idle(), c.gm.idle()]);
    }
    expect(c.texts()).toEqual(['while away']);
  });

  it('the sender keeps them across its own restart, and a restarted receiver does not show them twice', async () => {
    const w = world('A', 'B', 'C');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('Catch', [w.B.member, w.C.member]);
    await w.settle();
    w.disconnect(w.A, w.C);
    w.disconnect(w.B, w.C);
    await w.A.gm.send(gid, { text: 'kept by A' }); // B keeps a copy for C too
    await w.settle();
    expect(keptFor(w.B.gm, w.C.id)).toBe(1);
    const a = restarted(w.A, w.A.gm.exportState()); // A closes and reopens the app
    a.gm.importState(a.saved);
    const pair = memPair(w.A.id, w.C.id);
    const offA = a.gm.attach(pair.b);
    const offC = w.C.gm.attach(pair.a);
    for (let i = 0; i < 25; i++) {
      await sleep(4);
      await Promise.all([a.gm.idle(), w.C.gm.idle()]);
    }
    expect(texts(w.C)).toEqual(['kept by A']);
    // C restarts, then meets B, who still keeps a copy for C: it is not shown again, and B lets it go.
    const c = restarted(w.C, w.C.gm.exportState());
    c.gm.importState(c.saved);
    pair.close();
    offA();
    offC();
    const pb = memPair(w.B.id, w.C.id);
    w.B.gm.attach(pb.b);
    c.gm.attach(pb.a);
    for (let i = 0; i < 25; i++) {
      await sleep(4);
      await Promise.all([w.B.gm.idle(), c.gm.idle()]);
    }
    expect(c.texts()).toEqual([]);
    expect(keptFor(w.B.gm, w.C.id)).toBe(0);
  });

  it('kept frames are bounded per group (the oldest go first)', async () => {
    const w = worldWith({ maxKeptPerGroup: 3 }, 'A', 'C');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('Small', [w.C.member]);
    await w.settle();
    w.disconnect(w.A, w.C);
    for (let i = 1; i <= 5; i++) await w.A.gm.send(gid, { text: `m${i}` });
    expect(keptFor(w.A.gm, w.C.id)).toBe(3);
    w.connect(w.A, w.C);
    await w.settle();
    expect(texts(w.C).filter((t) => t.startsWith('m'))).toEqual(['m3', 'm4', 'm5']);
  });

  it('an older build that asks without "ack" gets each kept frame once (old behaviour)', async () => {
    const w = world('A', 'C');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('Old', [w.C.member]);
    await w.settle();
    w.disconnect(w.A, w.C);
    const r = await w.A.gm.send(gid, { text: 'x' });
    const t = tap(w.C.id);
    w.A.gm.attach(t);
    w.A.gm.onFrame(w.C.id, { k: 'g-req', ids: [r.mid] });
    await w.A.gm.idle();
    expect(t.frames.some((f) => (f as GroupFrame).k === 'g-msg')).toBe(true);
    expect(keptFor(w.A.gm, w.C.id)).toBe(0);
  });
});

describe('groups: connecting to members on demand', () => {
  it('asks the app to connect to members nobody reaches, at most once a minute each', async () => {
    const asked: string[] = [];
    let now = 1_000_000;
    const w = worldWith({ connect: (id) => asked.push(id), now: () => now }, 'A', 'B', 'C');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('G', [w.B.member, w.C.member]);
    await w.settle();
    asked.length = 0;
    w.disconnect(w.A, w.C);
    w.disconnect(w.B, w.C);
    await w.A.gm.send(gid, { text: 'one' });
    await w.A.gm.send(gid, { text: 'two' });
    await w.settle();
    expect(asked.filter((x) => x === w.C.id).length).toBeGreaterThanOrEqual(1);
    const fromA = asked.length;
    now += 61_000;
    await w.A.gm.send(gid, { text: 'three' });
    expect(asked.length).toBeGreaterThan(fromA);
    expect(asked).not.toContain(w.B.id); // B is connected
    w.connect(w.B, w.C); // "connected" by the app: C gets everything (B carried it)
    await w.settle();
    expect(texts(w.C).sort()).toEqual(['one', 'three', 'two']); // each once (kept frames come in any order)
  });
});

describe('groups: a join that was never saved (BUG-10)', () => {
  it('a member whose app lost the group gets the invite again on reconnect, joins, and reads what was sent meanwhile', async () => {
    const w = world('A', 'B', 'C');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('Lost', [w.B.member, w.C.member]);
    await w.settle();
    // C's app closed before anything was saved: C comes back with no groups at all.
    w.disconnect(w.A, w.C);
    w.disconnect(w.B, w.C);
    await w.A.gm.send(gid, { text: 'while C was gone' });
    await w.settle();
    const c = new GroupManager(w.C.me);
    const got: string[] = [];
    c.on('message', (m) => got.push((m.body as { text: string }).text));
    c.on('invite', (g) => void c.acceptInvite(g.id));
    const pair = memPair(w.A.id, w.C.id);
    w.A.gm.attach(pair.b);
    c.attach(pair.a);
    for (let i = 0; i < 40; i++) {
      await sleep(4);
      await Promise.all([w.A.gm.idle(), c.idle()]);
    }
    expect(c.get(gid)?.status).toBe('joined');
    expect(got).toEqual(['while C was gone']);
    await w.A.gm.send(gid, { text: 'after' });
    for (let i = 0; i < 25; i++) {
      await sleep(4);
      await Promise.all([w.A.gm.idle(), c.idle()]);
    }
    expect(got).toEqual(['while C was gone', 'after']);
  });
});

describe('groups: the group picture (a hash in the signed record)', () => {
  it('an admin sets and removes it; members see it; others cannot; a bad hash is refused', async () => {
    const w = world('A', 'B');
    w.acceptInvites();
    w.mesh();
    const gid = await w.A.gm.create('Pics', [w.B.member]);
    await w.settle();
    const h = 'ab'.repeat(32);
    await w.A.gm.setPicture(gid, h);
    await w.settle();
    expect(w.B.gm.get(gid)?.pic).toBe(h);
    expect(w.B.gm.record(gid)?.pic).toBe(h);
    await w.A.gm.rename(gid, 'Pics 2'); // other changes keep it
    await w.settle();
    expect(w.B.gm.get(gid)).toMatchObject({ name: 'Pics 2', pic: h });
    await expect(w.B.gm.setPicture(gid, 'cd'.repeat(32))).rejects.toThrow('Only admins');
    await expect(w.A.gm.setPicture(gid, 'XYZ')).rejects.toThrow();
    await w.A.gm.setPicture(gid, null);
    await w.settle();
    expect(w.B.gm.get(gid)?.pic).toBeUndefined();
    // A record whose picture field is not a hash is refused.
    const bad = { ...w.A.gm.record(gid)!, pic: 'not-a-hash' } as GroupRecord;
    expect(checkNext(w.A.gm.record(gid)!, bad)).toBe(false);
  });
});

