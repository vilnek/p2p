import { describe, expect, it } from 'vitest';
import { utf8, fromUtf8 } from '../../src/core/bytes';
import { identityFromPhrase, newPhrase } from '../../src/core/identity';
import { newEphemeral, SessionLock, type SessionInput } from '../../src/core/lock';
import { classify, PATH_TEXT } from '../../src/core/path';

async function pair() {
  const [a, b, c] = await Promise.all([identityFromPhrase(newPhrase()), identityFromPhrase(newPhrase()), identityFromPhrase(newPhrase())]);
  const ea = newEphemeral();
  const eb = newEphemeral();
  const base = { offerFingerprint: 'sha-256 AA', answerFingerprint: 'sha-256 BB' };
  const ia: SessionInput = { ...base, role: 'offerer', myIdentitySecret: a.secretKey, myIdentityPublic: a.publicKey, myEphemeralSecret: ea.secret, myEphemeralPublic: ea.public, peerIdentityPublic: b.publicKey, peerEphemeralPublic: eb.public };
  const ib: SessionInput = { ...base, role: 'answerer', myIdentitySecret: b.secretKey, myIdentityPublic: b.publicKey, myEphemeralSecret: eb.secret, myEphemeralPublic: eb.public, peerIdentityPublic: a.publicKey, peerEphemeralPublic: ea.public };
  // c pretends to be a, with a's one-time key but its own identity secret
  const ic: SessionInput = { ...ia, myIdentitySecret: c.secretKey };
  return { A: await SessionLock.create(ia), B: await SessionLock.create(ib), C: await SessionLock.create(ic) };
}

describe('chat lock (X25519 + HKDF + AES-256-GCM with counters)', () => {
  it('both ways', async () => {
    const { A, B } = await pair();
    expect(fromUtf8(await B.open(await A.seal(utf8('namaste'))))).toBe('namaste');
    expect(fromUtf8(await A.open(await B.seal(utf8('hello'))))).toBe('hello');
  });

  it('rejects a changed message, a replay, and a sender without the identity key', async () => {
    const { A, B, C } = await pair();
    const f = await A.seal(utf8('one'));
    const bad = f.slice();
    bad[bad.length - 1] ^= 1;
    await expect(B.open(bad)).rejects.toThrow();
    await B.open(f);
    await expect(B.open(f)).rejects.toThrow(/replayed/);
    await expect(B.open(await C.seal(utf8('fake')))).rejects.toThrow();
  });
});

describe('connection path', () => {
  it('names the path in plain words', () => {
    expect(classify({ candidateType: 'host' }, { candidateType: 'host' })).toBe('local');
    expect(classify({ candidateType: 'srflx' }, { candidateType: 'host', address: '49.36.1.2' })).toBe('internet');
    expect(classify({ candidateType: 'host' }, { candidateType: 'prflx', address: '192.168.1.9' })).toBe('local');
    expect(classify({ candidateType: 'host' }, { candidateType: 'prflx', address: '49.36.1.2' })).toBe('internet');
    expect(classify({ candidateType: 'relay' }, { candidateType: 'host' })).toBe('relay');
    expect(classify(undefined, undefined)).toBe('offline');
  });
});

describe('path icons (plan §8.8)', () => {
  it('match the plan', () => {
    const icons = Object.fromEntries(Object.entries(PATH_TEXT).map(([k, v]) => [k, v.icon]));
    expect(icons).toEqual({
      bluetooth: '📶',
      local: '🛜',
      'wifi-direct': '📡',
      internet: '🌐',
      postbox: '📮',
      'own-relay': '🏠',
      relay: '⚠️',
      offline: '○',
    });
  });
});
