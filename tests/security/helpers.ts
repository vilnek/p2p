// Small helpers for the security PoC tests (a mesh of GroupManagers over in-memory channels).
import { toB64url } from '../../src/core/bytes';
import { newGuestIdentity, p2pId } from '../../src/core/identity';
import { GroupManager, type GroupMember, type GroupMessage } from '../../src/net/groups';
import { memPair, sleep } from '../unit/memlink';

export interface Person {
  name: string;
  id: string;
  me: { secretKey: Uint8Array; publicKey: Uint8Array; name: string };
  gm: GroupManager;
  member: GroupMember;
  got: GroupMessage[];
}

export function people(...names: string[]) {
  const all: Person[] = names.map((name) => {
    const ident = newGuestIdentity();
    const me = { ...ident, name };
    const id = p2pId(ident.publicKey);
    const gm = new GroupManager(me);
    const p: Person = { name, id, me, gm, member: { p2pId: id, identityKey: toB64url(ident.publicKey), name }, got: [] };
    gm.on('message', (m) => p.got.push(m));
    gm.on('invite', (g) => void gm.acceptInvite(g.id));
    return p;
  });
  const connect = (a: Person, b: Person) => {
    const pair = memPair(b.id, a.id);
    a.gm.attach(pair.a);
    b.gm.attach(pair.b);
  };
  const mesh = (list = all) => list.forEach((a, i) => list.slice(i + 1).forEach((b) => connect(a, b)));
  const settle = async (rounds = 25) => {
    for (let i = 0; i < rounds; i++) {
      await sleep(2);
      await Promise.all(all.map((p) => p.gm.idle()));
    }
  };
  return { all, by: Object.fromEntries(all.map((p) => [p.name, p])) as Record<string, Person>, connect, mesh, settle };
}

export const texts = (p: Person) => p.got.map((m) => (m.body as { text?: string })?.text);
