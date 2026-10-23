// SECURITY_REVIEW_2026-10.md, finding H-3: both contacts subscribe to the SAME hourly "offer" tag,
// so a relay links the two connections (IP addresses) as contacts just from their REQ filters,
// all day long, without ever seeing a connection attempt.
// EXPECTED TO FAIL while the bug exists.
import { describe, expect, it } from 'vitest';
import { newGuestIdentity } from '../../src/core/identity';
import { pairKeys, pairTagsAround } from '../../src/core/pair';

describe('relays: subscriptions do not reveal who is whose contact', () => {
  it('the tags A listens on for B differ from the tags B listens on for A', () => {
    const a = newGuestIdentity();
    const b = newGuestIdentity();
    const now = Date.now();
    // What Hub.doRefresh() subscribes to on each side (src/net/hub.ts, "for (const c of contacts)").
    const aListens = pairTagsAround(pairKeys(a.secretKey, a.publicKey, b.publicKey).secret, 'offer', now);
    const bListens = pairTagsAround(pairKeys(b.secretKey, b.publicKey, a.publicKey).secret, 'offer', now);
    const shared = aListens.filter((t) => bListens.includes(t));
    expect(shared).toEqual([]); // FAILS today: all 3 tags are the same on both sides
  });
});
