// Security review 2026-10, groups: H-2 (fork order), M-4 (old-epoch messages), M-5 (group id bound
// to a signed genesis). The PoCs live in tests/security; these cover the rules around them.
import { describe, expect, it } from 'vitest';
import { fromB64url, toB64url, utf8 } from '../../src/core/bytes';
import { newGuestIdentity, p2pId, sign } from '../../src/core/identity';
import {
  GroupManager,
  checkGenesis,
  checkNext,
  forkWins,
  genesisId,
  recordHash,
  sealGroupMessage,
  signRecord,
  type GroupMember,
  type GroupMessage,
  type GroupRecord,
} from '../../src/net/groups';
import { memPair, sleep } from './memlink';

interface P {
  name: string;
  id: string;
  me: { secretKey: Uint8Array; publicKey: Uint8Array; name: string };
  gm: GroupManager;
  member: GroupMember;
  got: GroupMessage[];
  invites: string[];
}

function people(...names: string[]) {
  const all: P[] = names.map((name) => {
    const ident = newGuestIdentity();
    const me = { ...ident, name };
    const id = p2pId(ident.publicKey);
    const gm = new GroupManager(me);
    const p: P = { name, id, me, gm, member: { p2pId: id, identityKey: toB64url(ident.publicKey), name }, got: [], invites: [] };
    gm.on('message', (m) => p.got.push(m));
    gm.on('invite', (g) => (p.invites.push(g.id), void gm.acceptInvite(g.id)));
    return p;
  });
  const connect = (a: P, b: P) => {
    const pair = memPair(b.id, a.id);
    a.gm.attach(pair.a);
    b.gm.attach(pair.b);
  };
  const mesh = () => all.forEach((a, i) => all.slice(i + 1).forEach((b) => connect(a, b)));
  const settle = async (rounds = 25) => {
    for (let i = 0; i < rounds; i++) {
      await sleep(2);
      await Promise.all(all.map((p) => p.gm.idle()));
    }
  };
  return { by: Object.fromEntries(all.map((p) => [p.name, p])) as Record<string, P>, connect, mesh, settle };
}

const texts = (p: P) => p.got.map((m) => (m.body as { text?: string })?.text);

describe('groups: the group id is bound to a signed genesis (M-5)', () => {
  it('a new group id is the hash of its genesis, signed by the creator', async () => {
    const w = people('A', 'B');
    const { A, B } = w.by;
    w.connect(A, B);
    const gid = await A.gm.create('G', [B.member]);
    const gen = A.gm.record(gid)!;
    expect(gen.id).toBe(genesisId(gen));
    expect(checkGenesis(gen)).toBe(true);
    // The same content signed by someone else, or with another id, is not a genesis.
    const { id: _id, by: _by, sig: _sig, ...rest } = gen;
    expect(checkGenesis(signRecord(B.me, { ...rest, id: gid, admins: [B.id], createdBy: B.id }))).toBe(false);
    expect(checkGenesis({ ...gen, name: 'Other' })).toBe(false);
  });

  it('an invite without a genesis, or with a genesis for another id, is ignored', async () => {
    const w = people('A', 'X', 'N');
    const { A, X, N } = w.by;
    w.connect(A, X);
    const gid = await A.gm.create('Family', [X.member]);
    const other = await A.gm.create('Other', [X.member]);
    await w.settle();
    w.connect(X, N);
    const real = X.gm.record(gid)!;
    const fake = signRecord(X.me, { ...real, admins: [X.id], members: [...real.members, N.member], ts: Date.now() });
    N.gm.onFrame(X.id, { k: 'g-invite', gid, rec: fake });
    N.gm.onFrame(X.id, { k: 'g-invite', gid, rec: fake, gen: X.gm.record(other)! });
    await w.settle(5);
    expect(N.gm.get(gid)).toBeUndefined();
    expect(N.invites).toEqual([]);
  });

  it('the real genesis with a forged later record: the chain does not check, nothing is shown', async () => {
    const w = people('A', 'X', 'N');
    const { A, X, N } = w.by;
    w.connect(A, X);
    const gid = await A.gm.create('Family', [X.member]);
    await w.settle();
    await A.gm.rename(gid, 'Family 2');
    await w.settle();
    const gen = A.gm.record(gid)!; // epoch 1 now; take the genesis from X's export
    const genesis = X.gm.exportState().groups[0].gen!;
    expect(genesis.epoch).toBe(0);
    // X (not an admin) signs an epoch-2 record making itself admin and adding N, and serves it as the chain.
    const fake = signRecord(X.me, { ...gen, admins: [X.id], members: [...gen.members, N.member], epoch: 2, prev: recordHash(gen), ts: Date.now() });
    w.connect(X, N);
    N.gm.onFrame(X.id, { k: 'g-invite', gid, rec: fake, gen: genesis });
    N.gm.onFrame(X.id, { k: 'g-rec', gid, recs: [gen, fake] });
    await w.settle(5);
    expect(N.gm.get(gid)).toBeUndefined();
  });

  it('a newcomer added at a later epoch checks the chain from the genesis, then joins', async () => {
    const w = people('A', 'B', 'N');
    const { A, B, N } = w.by;
    w.mesh();
    const gid = await A.gm.create('G', [B.member]);
    await w.settle();
    await A.gm.rename(gid, 'G2');
    await A.gm.setAdmin(gid, B.id, true);
    await w.settle();
    await B.gm.addMembers(gid, [N.member]); // epoch 3, signed by B
    await w.settle();
    expect(N.gm.get(gid)).toMatchObject({ status: 'joined', epoch: 3, name: 'G2' });
    expect(N.gm.exportState().groups[0].history.map((r) => r.epoch).sort()).toEqual([0, 1, 2]);
    await A.gm.send(gid, { text: 'welcome N' });
    await w.settle();
    expect(texts(N)).toEqual(['welcome N']);
  });

  it('a group saved before ids were bound keeps working, but has no genesis to invite with', () => {
    const ident = newGuestIdentity();
    const me = { ...ident, name: 'A' };
    const member = { p2pId: p2pId(ident.publicKey), identityKey: toB64url(ident.publicKey), name: 'A' };
    const old = signRecord(me, { v: 1, id: toB64url(crypto.getRandomValues(new Uint8Array(16))), name: 'Old', createdBy: member.p2pId, admins: [member.p2pId], members: [member], epoch: 0, prev: '', ts: 1 });
    const gm = new GroupManager(me);
    gm.importState({ v: 1, groups: [{ rec: old, status: 'joined', history: [], keys: [], myKeys: [], epochEnded: [] }] });
    expect(gm.get(old.id)?.status).toBe('joined');
    expect(gm.exportState().groups[0].gen).toBeUndefined();
  });
});

describe('groups: fork order the signer cannot grind (H-2)', () => {
  const ids = () => {
    const p = people('A', 'B', 'C', 'D');
    return p.by;
  };

  it('mutual removal: the creator wins, whatever the hashes', () => {
    const { A, B, C } = ids();
    const parent = signRecord(A.me, { v: 1, id: 'g', name: 'G', createdBy: A.id, admins: [A.id, B.id], members: [A.member, B.member, C.member], epoch: 1, prev: 'p', ts: 1 });
    const byA = signRecord(A.me, { ...parent, admins: [A.id], members: [A.member, C.member], epoch: 2, prev: recordHash(parent), ts: 2 });
    for (let ts = 0; ts < 6; ts++) {
      const byB = signRecord(B.me, { ...parent, admins: [B.id], members: [B.member, C.member], epoch: 2, prev: recordHash(parent), ts });
      expect(checkNext(parent, byB)).toBe(true);
      expect(forkWins(parent, byA, byB)).toBe(true);
      expect(forkWins(parent, byB, byA)).toBe(false);
    }
  });

  it('a record that removes the other signer wins, even against the more senior admin', () => {
    const { A, B, C } = ids();
    const parent = signRecord(A.me, { v: 1, id: 'g', name: 'G', createdBy: A.id, admins: [A.id, B.id], members: [A.member, B.member, C.member], epoch: 1, prev: 'p', ts: 1 });
    const renameByA = signRecord(A.me, { ...parent, name: 'Renamed', epoch: 2, prev: recordHash(parent), ts: 2 });
    const demoteA = signRecord(B.me, { ...parent, admins: [B.id], epoch: 2, prev: recordHash(parent), ts: 3 });
    expect(forkWins(parent, demoteA, renameByA)).toBe(true);
    expect(forkWins(parent, renameByA, demoteA)).toBe(false);
  });

  it('then removals win, then seniority; the hash only orders one signer against itself', () => {
    const { A, B, C, D } = ids();
    const parent = signRecord(A.me, { v: 1, id: 'g', name: 'G', createdBy: A.id, admins: [A.id, B.id, C.id], members: [A.member, B.member, C.member, D.member], epoch: 3, prev: 'p', ts: 1 });
    const removeD = signRecord(C.me, { ...parent, members: [A.member, B.member, C.member], epoch: 4, prev: recordHash(parent), ts: 2 });
    const rename = signRecord(A.me, { ...parent, name: 'X', epoch: 4, prev: recordHash(parent), ts: 2 });
    expect(forkWins(parent, removeD, rename)).toBe(true);
    // B admin since epoch 1, C since epoch 3: B is senior.
    const since = (id: string) => (id === B.id ? 1 : 3);
    const byB = signRecord(B.me, { ...parent, name: 'B', epoch: 4, prev: recordHash(parent), ts: 5 });
    const byC = signRecord(C.me, { ...parent, name: 'C', epoch: 4, prev: recordHash(parent), ts: 5 });
    expect(forkWins(parent, byB, byC, since)).toBe(true);
    expect(forkWins(parent, byC, byB, since)).toBe(false);
    const byB2 = signRecord(B.me, { ...parent, name: 'B2', epoch: 4, prev: recordHash(parent), ts: 6 });
    expect(forkWins(parent, byB, byB2)).toBe(recordHash(byB) < recordHash(byB2));
  });

  it('end to end: an admin removed by the creator stays out, in any order', async () => {
    const w = people('A', 'M', 'B');
    const { A, M, B } = w.by;
    w.mesh();
    const gid = await A.gm.create('G', [M.member, B.member]);
    await w.settle();
    await A.gm.setAdmin(gid, M.id, true);
    await w.settle();
    const parent = B.gm.record(gid)!;
    await A.gm.removeMembers(gid, [M.id]);
    await w.settle();
    for (let ts = 0; ts < 4; ts++) {
      const forged = signRecord(M.me, { ...parent, admins: [M.id], members: parent.members.filter((m) => m.p2pId !== A.id), epoch: parent.epoch + 1, prev: recordHash(parent), ts });
      B.gm.onFrame(M.id, { k: 'g-rec', gid, recs: [forged] });
      A.gm.onFrame(M.id, { k: 'g-rec', gid, recs: [forged] });
    }
    await w.settle();
    for (const p of [A, B]) {
      expect(p.gm.get(gid)!.members.map((m) => m.p2pId).sort()).toEqual([A.id, B.id].sort());
      expect(p.gm.get(gid)!.admins).toEqual([A.id]);
    }
  });
});

describe('groups: old-epoch messages (M-4)', () => {
  async function setup() {
    const w = people('A', 'B', 'C');
    const { A, B, C } = w.by;
    w.mesh();
    const gid = await A.gm.create('G', [B.member, C.member]);
    await w.settle();
    return { w, A, B, C, gid };
  }
  const forge = async (p: P, gid: string, key: string, ts: number, text: string) => {
    const mid = toB64url(crypto.getRandomValues(new Uint8Array(9)));
    const ct = await sealGroupMessage(fromB64url(key), gid, 0, p.id, mid, { text });
    const sig = toB64url(sign(p.me.secretKey, utf8(JSON.stringify(['p2ptalk-gmsg-v1', gid, 0, mid, p.id, ts, ct]))));
    return { k: 'g-msg' as const, gid, epoch: 0, mid, from: p.id, ts, ct, sig, hop: 0, want: [] };
  };

  it('a member still in the group: an old-epoch message dated before the change opens; one dated well after it does not', async () => {
    const { w, A, B, C, gid } = await setup();
    const cKey = C.gm.exportState().groups[0].myKeys.find(([e]) => e === 0)![2];
    await A.gm.rename(gid, 'Next');
    await w.settle();
    const changedAt = B.gm.record(gid)!.ts;
    B.gm.onFrame(C.id, await forge(C, gid, cKey, changedAt - 1000, 'in flight'));
    B.gm.onFrame(C.id, await forge(C, gid, cKey, changedAt + 10 * 60_000, 'dated after the change'));
    await w.settle(5);
    expect(texts(B)).toEqual(['in flight']);
  });

  it('an old-epoch message that arrives after the grace period is dropped', async () => {
    let now = Date.now();
    const w = people('A', 'B', 'C');
    const { A, C } = w.by;
    const B2 = new GroupManager(w.by.B.me, { now: () => now });
    const got: GroupMessage[] = [];
    B2.on('message', (m) => got.push(m));
    B2.on('invite', (g) => void B2.acceptInvite(g.id));
    w.connect(A, C);
    const pAB = memPair(w.by.B.id, A.id);
    A.gm.attach(pAB.a);
    B2.attach(pAB.b);
    const pCB = memPair(w.by.B.id, C.id);
    C.gm.attach(pCB.a);
    B2.attach(pCB.b);
    const gid = await A.gm.create('G', [w.by.B.member, C.member]);
    await w.settle();
    await B2.idle();
    const cKey = C.gm.exportState().groups[0].myKeys.find(([e]) => e === 0)![2];
    const before = Date.now();
    await A.gm.rename(gid, 'Next');
    await w.settle();
    await B2.idle();
    now += 6 * 60_000; // more than the default 5 minutes
    B2.onFrame(C.id, await forge(C, gid, cKey, before - 1, 'too late'));
    await w.settle(5);
    await B2.idle();
    expect(got.map((m) => (m.body as { text: string }).text)).not.toContain('too late');
  });
});

describe('groups: waiting queues (L-5)', () => {
  it('future-epoch frames with a bad signature are not queued, and one sender has a cap', async () => {
    const w = people('A', 'B', 'C');
    const { A, B, C } = w.by;
    w.mesh();
    const gid = await A.gm.create('G', [B.member, C.member]);
    await w.settle();
    const queued = () => (B.gm as unknown as { pendingMsgs: { f: { from: string } }[] }).pendingMsgs;
    const frame = (from: P, i: number, good: boolean) => {
      const mid = toB64url(crypto.getRandomValues(new Uint8Array(9)));
      const ct = 'A'.repeat(40);
      const head = { gid, epoch: 5, mid, from: from.id, ts: Date.now() + i, ct };
      const sig = good ? toB64url(sign(from.me.secretKey, utf8(JSON.stringify(['p2ptalk-gmsg-v1', gid, 5, mid, from.id, head.ts, ct])))) : 'A'.repeat(86);
      return { k: 'g-msg' as const, ...head, sig, hop: 0, want: [] };
    };
    for (let i = 0; i < 50; i++) B.gm.onFrame(C.id, frame(C, i, false));
    await w.settle(3);
    expect(queued().length).toBe(0);
    for (let i = 0; i < 150; i++) B.gm.onFrame(C.id, frame(C, i, true));
    B.gm.onFrame(A.id, frame(A, 0, true));
    await w.settle(5);
    expect(queued().filter((p) => p.f.from === C.id).length).toBe(100);
    expect(queued().filter((p) => p.f.from === A.id).length).toBe(1);
  });
});
