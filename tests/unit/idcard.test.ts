import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519';
import { checkIdCard, extractId, idCardTag, makeIdCard, shareIdText } from '../../src/core/idcard';
import { formatId, idIsValid, identityFromPhrase, newPhrase, p2pId } from '../../src/core/identity';

describe('copy / paste a P2P ID', () => {
  const id = '395064155608899644355146'; // test vector 1 (PROTOCOL §16)

  it('finds the 24 digits in any format', () => {
    expect(extractId(id)).toBe(id);
    expect(extractId(formatId(id))).toBe(id);
    expect(extractId('3950-6415-5608-8996-4435-5146')).toBe(id);
    expect(extractId('3950 6415\n5608 8996\r\n4435 5146')).toBe(id);
    expect(extractId(shareIdText(formatId(id)))).toBe(id);
    expect(extractId(`Hi! ${shareIdText(formatId(id))} · call me at 9:30`)).toBe(id);
    expect(shareIdText(formatId(id))).toBe('My P2P Talk ID: 3950 6415 5608 8996 4435 5146');
  });

  it('refuses too few or too many digits, and the Damm check catches a typo', () => {
    expect(extractId('3950 6415 5608 8996 4435 514')).toBeNull();
    expect(extractId('3950 6415 5608 8996 4435 51467')).toBeNull();
    expect(extractId('no digits here')).toBeNull();
    const typo = id.slice(0, 10) + ((Number(id[10]) + 1) % 10) + id.slice(11);
    expect(extractId(typo)).toBe(typo);
    expect(idIsValid(typo)).toBe(false);
    expect(idIsValid(id)).toBe(true);
  });
});

describe('relay card for "Findable by my ID"', () => {
  it('only a card whose key gives exactly that ID, correctly signed and recent, is accepted', async () => {
    const [a, b] = await Promise.all([identityFromPhrase(newPhrase()), identityFromPhrase(newPhrase())]);
    const box = x25519.getPublicKey(x25519.utils.randomPrivateKey());
    const idA = p2pId(a.publicKey);
    const card = makeIdCard(a.secretKey, a.publicKey, 'Ravi', box, '00112233445566778899aabbccddeeff', ['wss://nos.lol']);
    expect(checkIdCard(idA, card)).toEqual(card);
    expect(checkIdCard(p2pId(b.publicKey), card)).toBeNull(); // another ID
    expect(checkIdCard(idA, { ...card, n: 'Evil' })).toBeNull(); // changed
    const signedByB = makeIdCard(b.secretKey, a.publicKey, 'Ravi', box, card.bid, card.rr);
    expect(checkIdCard(idA, signedByB)).toBeNull(); // not signed by the key behind the ID
    expect(checkIdCard(idA, card, Date.now() + 49 * 3600_000)).toBeNull(); // too old
    expect(idCardTag(idA)).toMatch(/^[0-9a-f]{64}$/);
    expect(idCardTag(idA)).not.toBe(idCardTag(p2pId(b.publicKey)));
  });
});
