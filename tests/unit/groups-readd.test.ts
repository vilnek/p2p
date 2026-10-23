// A member removed from a group (or who left) and added again by an admin must see the invite again
// (status 'invited'), join, and read messages. Before the fix the status stayed 'removed' / 'left' for
// good and the re-add was silent.

import { describe, expect, it } from 'vitest';
import { toB64url } from '../../src/core/bytes';
import { newGuestIdentity, p2pId } from '../../src/core/identity';
import { GroupManager, type GroupInfo, type GroupMember, type GroupMessage } from '../../src/net/groups';
import { memPair, sleep } from './memlink';

interface Person {
  id: string;
  gm: GroupManager;
  member: GroupMember;
  got: GroupMessage[];
  invites: GroupInfo[];
}

function world(...names: string[]) {
  const people: Person[] = names.map((name) => {
    const ident = newGuestIdentity();
    const id = p2pId(ident.publicKey);
    const gm = new GroupManager({ ...ident, name });
    const p: Person = { id, gm, member: { p2pId: id, identityKey: toB64url(ident.publicKey), name }, got: [], invites: [] };
    gm.on('message', (m) => p.got.push(m));
    gm.on('invite', (g) => p.invites.push(g));
    return p;
  });
  for (let i = 0; i < people.length; i++)
    for (let j = i + 1; j < people.length; j++) {
      const pair = memPair(people[j].id, people[i].id);
      people[i].gm.attach(pair.a);
      people[j].gm.attach(pair.b);
    }
  const settle = async (rounds = 25) => {
    for (let i = 0; i < rounds; i++) {
      await sleep(2);
      await Promise.all(people.map((p) => p.gm.idle()));
    }
  };
  return { people, settle };
}

describe('groups: a removed member added again', () => {
  it('is invited again, can join, and reads new messages', async () => {
    const { people, settle } = world('A', 'B', 'C');
    const [A, B, C] = people;
    const gid = await A.gm.create('G', [B.member, C.member]);
    await settle();
    await B.gm.acceptInvite(gid);
    await C.gm.acceptInvite(gid);
    await settle();
    expect(B.gm.get(gid)?.status).toBe('joined');

    await A.gm.removeMembers(gid, [B.id]);
    await settle();
    expect(B.gm.get(gid)?.status).toBe('removed');
    const invitesBefore = B.invites.length;

    await A.gm.addMembers(gid, [B.member]);
    await settle();
    expect(B.gm.get(gid)?.status).toBe('invited');
    expect(B.invites.length).toBe(invitesBefore + 1);
    expect(B.invites[B.invites.length - 1].id).toBe(gid);

    await B.gm.acceptInvite(gid);
    await settle();
    expect(B.gm.get(gid)?.status).toBe('joined');
    await A.gm.send(gid, { text: 'welcome back' });
    await settle();
    expect(B.got.some((m) => (m.body as { text: string }).text === 'welcome back')).toBe(true);
    // C, who stayed, sees the same current record.
    expect(C.gm.get(gid)?.epoch).toBe(B.gm.get(gid)?.epoch);
  });

  it('a member who left is invited again when an admin adds them back', async () => {
    const { people, settle } = world('A', 'B');
    const [A, B] = people;
    const gid = await A.gm.create('G', [B.member]);
    await settle();
    await B.gm.acceptInvite(gid);
    await settle();
    await B.gm.leave(gid);
    await settle();
    expect(B.gm.get(gid)?.status).toBe('left');
    expect(A.gm.get(gid)?.members.some((m) => m.p2pId === B.id)).toBe(false); // the admin removed the leaver

    await A.gm.addMembers(gid, [B.member]);
    await settle();
    expect(B.gm.get(gid)?.status).toBe('invited');
    await B.gm.acceptInvite(gid);
    await settle();
    expect(B.gm.get(gid)?.status).toBe('joined');
  });
});
