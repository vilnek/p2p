// SECURITY_REVIEW_2026-10.md, finding M-4: after removal, a member can still inject messages for up
// to 1 hour by labelling them with the old epoch (oldEpochGraceMs), with any timestamp.
// EXPECTED TO FAIL while the bug exists.
import { describe, expect, it } from 'vitest';
import { fromB64url, toB64url, utf8 } from '../../src/core/bytes';
import { sign } from '../../src/core/identity';
import { sealGroupMessage } from '../../src/net/groups';
import { people, texts } from './helpers';

describe('groups: a removed member cannot post', () => {
  it('B drops an old-epoch message sent by C after C was removed', async () => {
    const w = people('A', 'B', 'C');
    const { A, B, C } = w.by;
    w.mesh();
    const gid = await A.gm.create('G', [B.member, C.member]);
    await w.settle();
    const cKey = C.gm.exportState().groups[0].myKeys.find(([e]) => e === 0)!;
    await A.gm.removeMembers(gid, [C.id]);
    await w.settle();
    expect(B.gm.get(gid)!.epoch).toBe(1);

    // C, already removed, writes with its epoch-0 key and back-dates the message.
    const mid = toB64url(crypto.getRandomValues(new Uint8Array(9)));
    const ts = Date.now() - 3600_000;
    const ct = await sealGroupMessage(fromB64url(cKey[2]), gid, 0, C.id, mid, { text: 'send the money to me' });
    const sig = toB64url(sign(C.me.secretKey, utf8(JSON.stringify(['p2ptalk-gmsg-v1', gid, 0, mid, C.id, ts, ct]))));
    B.gm.onFrame(C.id, { k: 'g-msg', gid, epoch: 0, mid, from: C.id, ts, ct, sig, hop: 0, want: [] });
    await w.settle();

    expect(texts(B)).not.toContain('send the money to me'); // FAILS today
  });
});
