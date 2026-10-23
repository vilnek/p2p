// SECURITY_REVIEW_2026-10.md, finding H-2: a removed admin undoes the removal through "fork
// resolution" (lowest record hash wins at the same epoch), and can remove the admin who removed them.
// EXPECTED TO FAIL while the bug exists.
import { describe, expect, it } from 'vitest';
import { recordHash, signRecord, type GroupRecord } from '../../src/net/groups';
import { people } from './helpers';

describe('groups: a removed admin cannot come back by forking', () => {
  it('B keeps the removal record; M stays out', async () => {
    const w = people('A', 'M', 'B');
    const { A, M, B } = w.by;
    w.mesh();
    const gid = await A.gm.create('G', [M.member, B.member]);
    await w.settle();
    await A.gm.setAdmin(gid, M.id, true); // epoch 1: A and M are admins
    await w.settle();
    const parent = B.gm.record(gid)!; // epoch 1
    expect(parent.admins.sort()).toEqual([A.id, M.id].sort());

    await A.gm.removeMembers(gid, [M.id]); // epoch 2: M removed
    await w.settle();
    expect(B.gm.get(gid)!.members.map((m) => m.p2pId)).not.toContain(M.id);
    const realHash = recordHash(B.gm.record(gid)!);

    // M (an admin of epoch 1) signs a competing epoch-2 record that removes A, and grinds the
    // timestamp until its hash sorts lower than the real one (about 2 tries on average).
    let forged: GroupRecord;
    let ts = Date.now();
    do {
      forged = signRecord(M.me, {
        v: 1,
        id: gid,
        name: parent.name,
        createdBy: parent.createdBy,
        admins: [M.id],
        members: parent.members.filter((m) => m.p2pId !== A.id),
        epoch: parent.epoch + 1,
        prev: recordHash(parent),
        ts: ts++,
      });
    } while (recordHash(forged) >= realHash);

    B.gm.onFrame(M.id, { k: 'g-rec', gid, recs: [forged] });
    await w.settle();

    const now = B.gm.get(gid)!;
    expect(now.members.map((m) => m.p2pId)).not.toContain(M.id); // FAILS today: M is back
    expect(now.members.map((m) => m.p2pId)).toContain(A.id); //     FAILS today: A was removed
  });
});
