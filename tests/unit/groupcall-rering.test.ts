// A group call I missed (the ring ran out) must ring again when someone in the call invites me
// again: the manager answers them "ringing", so its own screen must ring too. Before the fix the
// second invite left the call 'missed' with no 'invite' event (they saw "ringing" for 45 s, I saw
// nothing). No WebRTC is needed: nothing joins.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toB64url } from '../../src/core/bytes';
import { newGuestIdentity, p2pId, sign } from '../../src/core/identity';
import { GroupCallManager, frameBytes, type GroupCallFrame, type GroupCallInfo, type GroupSource } from '../../src/net/groupCall';

describe('group call: an invite for a missed call', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  it('rings again (state incoming, a new invite event), and the inviter gets a ring back', async () => {
    const me = { ...newGuestIdentity(), name: 'Me' };
    const other = { ...newGuestIdentity(), name: 'Ravi' };
    const myId = p2pId(me.publicKey);
    const otherId = p2pId(other.publicKey);
    const gid = 'g1';
    const rec = {
      id: gid,
      name: 'Seva',
      members: [
        { p2pId: myId, identityKey: toB64url(me.publicKey), name: 'Me' },
        { p2pId: otherId, identityKey: toB64url(other.publicKey), name: 'Ravi' },
      ],
    };
    const groups: GroupSource = { record: () => rec, get: () => ({ status: 'joined', name: 'Seva' }) };
    const sent: GroupCallFrame[] = [];
    const m = new GroupCallManager({
      me,
      groups,
      send: async (_to, f) => void sent.push(f),
      ringMs: 40,
      pollMs: 0,
    });
    const invites: GroupCallInfo[] = [];
    const calls: GroupCallInfo[] = [];
    m.on('invite', (c) => invites.push(c));
    m.on('call', (c) => calls.push(c));

    const invite = (): GroupCallFrame => {
      const f = { k: 'gc-invite', cid: 'call1', gid, from: otherId, to: myId, ts: Date.now(), video: false, in: [{ id: otherId, sid: 's1' }], sig: '' } as GroupCallFrame;
      f.sig = toB64url(sign(other.secretKey, frameBytes(f)));
      return f;
    };

    m.onFrame(otherId, invite());
    await m.idle();
    expect(invites.length).toBe(1);
    expect(m.joinable(gid)[0]?.state).toBe('incoming');
    expect(sent.filter((f) => f.k === 'gc-ring').length).toBe(1);

    await vi.advanceTimersByTimeAsync(40 + 5000 + 10); // the callee ring limit is ringMs + 5 s: 'missed'
    await m.idle();
    expect(m.joinable(gid)[0]?.state).toBe('missed');

    m.onFrame(otherId, invite());
    await m.idle();
    expect(sent.filter((f) => f.k === 'gc-ring').length).toBe(2);
    expect(invites.length).toBe(2);
    expect(m.joinable(gid)[0]?.state).toBe('incoming');

    // Declining the second ring answers the inviter, as for the first.
    await m.decline('call1');
    expect(sent.some((f) => f.k === 'gc-decline' && f.to === otherId)).toBe(true);
    expect(m.joinable(gid)[0]?.state).toBe('declined');
    m.destroy();
  });
});
