import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { EMOJI_256 } from '../../src/core/emoji';
import { dammValid } from '../../src/core/damm';
import { emojiCode, formatId, identityFromPhrase, idIsValid, newPhrase, p2pId, phraseIsValid } from '../../src/core/identity';

// The standard BIP-39 test phrase (24 words, all "abandon" + "art").
const FIXED = 'abandon '.repeat(23) + 'art';

describe('24-word phrase -> key -> 24-digit P2P ID', () => {
  it('makes 24 valid words', () => {
    const p = newPhrase();
    expect(p.split(' ')).toHaveLength(24);
    expect(phraseIsValid(p)).toBe(true);
  });

  it('the same 24 words always give the same key and ID', async () => {
    const p = newPhrase();
    const a = await identityFromPhrase(p);
    const b = await identityFromPhrase(`  ${p.toUpperCase().split(' ').join('   ')}  `);
    expect(b.publicKey).toEqual(a.publicKey);
    expect(p2pId(b.publicKey)).toBe(p2pId(a.publicKey));
    expect(emojiCode(b.publicKey)).toBe(emojiCode(a.publicKey));
  });

  it('is stable across versions (fixed test vector)', async () => {
    const id = await identityFromPhrase(FIXED);
    const pid = p2pId(id.publicKey);
    expect(pid).toMatch(/^\d{24}$/);
    expect(dammValid(pid)).toBe(true);
    // Recorded once; if this changes, every user's ID changes.
    expect(pid).toMatchInlineSnapshot(`"395064155608899644355146"`);
  });

  it('a different key gives a different ID and emoji code', async () => {
    const a = await identityFromPhrase(newPhrase());
    const b = await identityFromPhrase(newPhrase());
    expect(p2pId(a.publicKey)).not.toBe(p2pId(b.publicKey));
    expect(emojiCode(a.publicKey)).not.toBe(emojiCode(b.publicKey));
    const ids = new Set<string>();
    for (let i = 0; i < 300; i++) ids.add(p2pId(ed25519.getPublicKey(ed25519.utils.randomPrivateKey())));
    expect(ids.size).toBe(300);
  });

  it('IDs are 24 digits with a valid check digit, shown as 6 groups of 4', async () => {
    const id = p2pId((await identityFromPhrase(newPhrase())).publicKey);
    expect(id).toHaveLength(24);
    expect(idIsValid(id)).toBe(true);
    expect(formatId(id)).toMatch(/^\d{4}( \d{4}){5}$/);
    const typo = id.slice(0, 5) + ((+id[5] + 1) % 10) + id.slice(6);
    expect(idIsValid(typo)).toBe(false);
  });

  it('rejects wrong words', () => {
    expect(phraseIsValid('abandon '.repeat(24).trim())).toBe(false); // bad checksum
    expect(phraseIsValid('hello world')).toBe(false);
  });

  it('emoji list has 256 different emoji; codes are 4 emoji', async () => {
    expect(new Set(EMOJI_256).size).toBe(256);
    const code = emojiCode((await identityFromPhrase(FIXED)).publicKey);
    expect(Array.from(code)).toHaveLength(4);
  });
});
