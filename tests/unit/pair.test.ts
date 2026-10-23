import { describe, expect, it } from 'vitest';
import { fromUtf8, utf8 } from '../../src/core/bytes';
import { identityFromPhrase, newPhrase } from '../../src/core/identity';
import { LEGACY_PAIR_TAGS_UNTIL, hourOf, memberPairKeys, openPairOffer, openPairReply, pairKeys, pairListenTags, pairSendTags, pairTag, pairTagsAround, sealPairOffer, sealPairReply } from '../../src/core/pair';

const me = () => identityFromPhrase(newPhrase());

describe('contact reconnect (private hourly tags, forward-secret locks)', () => {
  // Security review H-3: this test used to require the SAME tag secret on both sides; that shared
  // secret made both contacts subscribe to the same relay filter (the bug). Now the lock secret is
  // shared, and the tag keys are per direction: my inbox key is their `out` key.
  it('both contacts derive the same lock secret, and opposite inbox keys; a third key cannot', async () => {
    const [a, b, c] = await Promise.all([me(), me(), me()]);
    const ab = pairKeys(a.secretKey, a.publicKey, b.publicKey);
    const ba = pairKeys(b.secretKey, b.publicKey, a.publicKey);
    expect(ab.shared).toEqual(ba.shared);
    expect(ab.id).toEqual(ba.id);
    expect(ab.secret).toEqual(ba.out);
    expect(ab.out).toEqual(ba.secret);
    expect(ab.secret).not.toEqual(ba.secret);
    // Someone who knows both PUBLIC keys but neither secret key gets something else.
    const cb = pairKeys(c.secretKey, a.publicKey, b.publicKey);
    expect(cb.shared).not.toEqual(ab.shared);
    expect(cb.secret).not.toEqual(ab.secret);
  });

  it('per-direction tags: what I post lands on what they listen on; we never listen on the same tag', async () => {
    const [a, b] = await Promise.all([me(), me()]);
    const ab = pairKeys(a.secretKey, a.publicKey, b.publicKey);
    const ba = pairKeys(b.secretKey, b.publicKey, a.publicKey);
    const later = LEGACY_PAIR_TAGS_UNTIL + 3600_000;
    for (const now of [Date.now(), later]) {
      for (const dir of ['offer', 'reply', 'taken'] as const) {
        const aListens = pairListenTags(ab, dir, now);
        const bListens = pairListenTags(ba, dir, now);
        expect(pairSendTags(ab, dir, now)[0]).toBe(pairTag(ba.secret, dir, hourOf(now)));
        expect(bListens).toContain(pairSendTags(ab, dir, now)[0]);
        expect(aListens).toContain(pairSendTags(ba, dir, now)[0]);
        // Offers (the long-lived subscription) never share a tag, also during the transition.
        if (dir === 'offer') expect(aListens.filter((t) => bListens.includes(t))).toEqual([]);
        // The old shared offer tag is never listened on.
        expect(aListens).not.toContain(pairTag(ab.shared, 'offer', hourOf(now)));
      }
    }
    // Transition: offers and notes also go on the old shared tag; replies are read there during my attempt.
    expect(pairSendTags(ab, 'offer', Date.UTC(2026, 9, 25))).toContain(pairTag(ab.shared, 'offer', hourOf(Date.UTC(2026, 9, 25))));
    expect(pairSendTags(ab, 'reply', Date.UTC(2026, 9, 25))).toHaveLength(1);
    expect(pairListenTags(ab, 'reply', Date.UTC(2026, 9, 25))).toContain(pairTag(ab.shared, 'reply', hourOf(Date.UTC(2026, 9, 25))));
    expect(pairSendTags(ab, 'offer', later)).toHaveLength(1);
    expect(pairListenTags(ab, 'reply', later)).toHaveLength(3);
  });

  it('tags change every hour and differ for offer and reply', async () => {
    const [a, b] = await Promise.all([me(), me()]);
    const { secret } = pairKeys(a.secretKey, a.publicKey, b.publicKey);
    const h = hourOf();
    expect(pairTag(secret, 'offer', h)).not.toBe(pairTag(secret, 'offer', h + 1));
    expect(pairTag(secret, 'offer', h)).not.toBe(pairTag(secret, 'reply', h));
    expect(pairTagsAround(secret, 'offer')).toContain(pairTag(secret, 'offer'));
    expect(pairTag(secret, 'offer')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('offer and reply round trip; others and changed messages are rejected', async () => {
    const [a, b, c] = await Promise.all([me(), me(), me()]);
    const ab = pairKeys(a.secretKey, a.publicKey, b.publicKey);
    const ba = pairKeys(b.secretKey, b.publicKey, a.publicKey);
    const offer = await sealPairOffer(ab, b.publicKey, utf8('offer'));
    const opened = await openPairOffer(ba, b.secretKey, offer.blob);
    expect(fromUtf8(opened.plain)).toBe('offer');
    const reply = await sealPairReply(ba, opened.ephPub, utf8('answer'));
    expect(fromUtf8(await openPairReply(ab, offer.ephSecret, reply))).toBe('answer');

    // C has its own pair with B, and can't open A's offer to B.
    const cb = pairKeys(c.secretKey, c.publicKey, b.publicKey);
    await expect(openPairOffer(cb, c.secretKey, offer.blob)).rejects.toThrow();
    const bad = offer.blob.slice();
    bad[bad.length - 1] ^= 1;
    await expect(openPairOffer(ba, b.secretKey, bad)).rejects.toThrow();
    // The same message twice is locked with different fresh keys.
    const again = await sealPairOffer(ab, b.publicKey, utf8('offer'));
    expect(again.blob.slice(0, 32)).not.toEqual(offer.blob.slice(0, 32));
  });
});

describe('group-member links (members who are not contacts)', () => {
  it('both members derive the same lock and opposite inboxes, bound to the group; not the contact pair, not another group', async () => {
    const [a, b] = await Promise.all([me(), me()]);
    const ab = memberPairKeys(a.secretKey, a.publicKey, b.publicKey, 'G1');
    const ba = memberPairKeys(b.secretKey, b.publicKey, a.publicKey, 'G1');
    expect(ab.shared).toEqual(ba.shared);
    expect(ab.secret).toEqual(ba.out);
    expect(ab.secret).not.toEqual(ba.secret);
    const contact = pairKeys(a.secretKey, a.publicKey, b.publicKey);
    const other = memberPairKeys(a.secretKey, a.publicKey, b.publicKey, 'G2');
    for (const x of [contact, other]) {
      expect(x.shared).not.toEqual(ab.shared);
      expect(x.secret).not.toEqual(ab.secret);
      expect(x.id).not.toEqual(ab.id);
    }
    // An offer for the group link opens only with the group link.
    const offer = await sealPairOffer(ab, b.publicKey, utf8('hello member'));
    expect(fromUtf8((await openPairOffer(ba, b.secretKey, offer.blob)).plain)).toBe('hello member');
    await expect(openPairOffer(pairKeys(b.secretKey, b.publicKey, a.publicKey), b.secretKey, offer.blob)).rejects.toThrow();
  });

  it('posts only on the per-direction tags (no old shared tags), and never listens where the other listens', async () => {
    const [a, b] = await Promise.all([me(), me()]);
    const ab = memberPairKeys(a.secretKey, a.publicKey, b.publicKey, 'G');
    const ba = memberPairKeys(b.secretKey, b.publicKey, a.publicKey, 'G');
    const before = LEGACY_PAIR_TAGS_UNTIL - 3600_000;
    expect(pairSendTags(ab, 'offer', before)).toEqual([pairTag(ab.out, 'offer', hourOf(before))]);
    expect(pairListenTags(ab, 'reply', before)).toEqual(pairTagsAround(ab.secret, 'reply', before));
    expect(pairTagsAround(ba.secret, 'offer', before)).toContain(pairSendTags(ab, 'offer', before)[0]);
    const mine = new Set(pairTagsAround(ab.secret, 'offer', before));
    expect(pairTagsAround(ba.secret, 'offer', before).some((t) => mine.has(t))).toBe(false);
  });
});
