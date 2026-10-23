// SECURITY_REVIEW_2026-10.md, finding M-5: any member can forge a different "first" record for an
// existing group id (signed by itself as admin) and give it to a newcomer, who then follows the fake
// group (attacker as admin) and ignores the real one.
// EXPECTED TO FAIL while the bug exists.
import { describe, expect, it } from 'vitest';
import { signRecord } from '../../src/net/groups';
import { people } from './helpers';

describe('groups: a member cannot squat a group id', () => {
  it('a newcomer does not adopt a forged base record for an existing gid', async () => {
    const w = people('A', 'X', 'N');
    const { A, X, N } = w.by;
    w.connect(A, X);
    const gid = await A.gm.create('Family', [X.member]);
    await w.settle();
    const real = X.gm.record(gid)!;

    // X (not an admin) makes its own record with the same id, X as admin, and N in it.
    const fake = signRecord(X.me, { ...real, admins: [X.id], members: [...real.members, N.member], epoch: real.epoch + 5, prev: 'x', ts: Date.now() });
    w.connect(X, N);
    N.gm.onFrame(X.id, { k: 'g-invite', gid, rec: fake });
    await w.settle();

    const g = N.gm.get(gid);
    expect(g?.admins ?? []).not.toContain(X.id); // FAILS today: N follows X's fake group
  });
});
