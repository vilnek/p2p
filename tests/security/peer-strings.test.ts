// Security review (23 Oct 2026, second pass): strings a peer chooses (a card's name and custom relays,
// a code's display name, an ID card's name and relay list) are self-signed, so the signature proves
// nothing about their size or type. The decoders must hold them to the limits the encoders use.
import { describe, expect, it } from 'vitest';
import { concat, fromB64url, toB64url, utf8 } from '../../src/core/bytes';
import { decodeCard, newCard } from '../../src/core/card';
import { checkIdCard, makeIdCard } from '../../src/core/idcard';
import { newGuestIdentity, p2pId, sign } from '../../src/core/identity';
import { makeCode, signedBytes, verifyCode } from '../../src/core/signal';

const SDP = 'v=0\r\na=fingerprint:sha-256 AB:CD:EF:01\r\na=setup:actpass\r\n';

describe('connect card: name and relay lists are capped on decode', () => {
  const me = newGuestIdentity();

  /** Re-signs a hand-made card body with the identity key. */
  const cardText = (body: Uint8Array) => toB64url(concat(body, sign(me.secretKey, concat(utf8('p2ptalk-card-v1'), body))));

  it('accepts the cards the app makes (16-byte name, built-in relays)', () => {
    const { text } = newCard(me.secretKey, me.publicKey, ['wss://nos.lol'], Date.now(), { invite: true, name: 'Dr Vijaykumar Katariya' });
    const c = decodeCard(text);
    expect(c.kind).toBe('invite');
    expect(utf8(c.name).length).toBeLessThanOrEqual(16);
  });

  it('refuses a name longer than 16 bytes, more than 8 custom relays, and trailing bytes', () => {
    const base = fromB64url(newCard(me.secretKey, me.publicKey, ['wss://nos.lol'], Date.now(), { invite: true }).text);
    const head = base.subarray(0, 85).slice();
    // A 40-byte name after the header (flag bit 2).
    head[0] |= 4;
    const longName = utf8('x'.repeat(40));
    expect(() => decodeCard(cardText(concat(head, Uint8Array.of(longName.length), longName)))).toThrow(/damaged/);
    // 9 custom relays (flag bit 0).
    const head2 = base.subarray(0, 85).slice();
    head2[0] |= 1;
    const relay = utf8('wss://x.example');
    const nine = concat(Uint8Array.of(9), ...Array.from({ length: 9 }, () => concat(Uint8Array.of(relay.length), relay)));
    expect(() => decodeCard(cardText(concat(head2, nine)))).toThrow(/damaged/);
    // Bytes after the fields.
    expect(() => decodeCard(cardText(concat(base.subarray(0, 85), Uint8Array.of(1, 2, 3))))).toThrow(/damaged/);
    // A length that runs past the end.
    const head3 = base.subarray(0, 85).slice();
    head3[0] |= 4;
    expect(() => decodeCard(cardText(concat(head3, Uint8Array.of(16), utf8('short'))))).toThrow(/damaged/);
  });
});

describe('connect code: the display name must be a string, and is cut to 40 characters', () => {
  const me = newGuestIdentity();
  const eph = new Uint8Array(32).fill(7);

  it('a non-string name is refused even when the signature was made over it', () => {
    const code = makeCode({ kind: 'offer', sdp: SDP, identitySecret: me.secretKey, identityPublic: me.publicKey, ephemeralPublic: eph, name: 'A' });
    const bad = { ...code, n: { toString: 'x' } as unknown as string };
    // Signed over the object form, as a tampered client would do.
    bad.g = toB64url(sign(me.secretKey, utf8(JSON.stringify(['p2ptalk-sig-v1', 'o', 'sha-256 AB:CD:EF:01', code.k, code.e, bad.n, '']))));
    expect(() => verifyCode(bad, 'offer')).toThrow(/damaged/);
  });

  it('a 500-character name (self-signed) comes out as 40', () => {
    const code = makeCode({ kind: 'offer', sdp: SDP, identitySecret: me.secretKey, identityPublic: me.publicKey, ephemeralPublic: eph, name: 'A' });
    const long = { ...code, n: 'N'.repeat(500) };
    long.g = toB64url(sign(me.secretKey, signedBytes('o', 'sha-256 AB:CD:EF:01', code.k, code.e, long.n, '')));
    const v = verifyCode(long, 'offer');
    expect(v.name).toBe('N'.repeat(40));
  });
});

describe('ID card: name and relays are typed and capped', () => {
  const me = newGuestIdentity();
  const id = p2pId(me.publicKey);
  const box = new Uint8Array(32).fill(9);
  const bid = 'ab'.repeat(16);

  const resigned = (c: ReturnType<typeof makeIdCard>, patch: Record<string, unknown>) => {
    const x = { ...c, ...patch } as Record<string, unknown>;
    x.g = toB64url(sign(me.secretKey, utf8(JSON.stringify(['p2ptalk-idcard-v1', x.k, x.n, x.rb, x.bid, x.rr, x.ts]))));
    return x;
  };

  it('the card the app makes passes', () => {
    expect(checkIdCard(id, makeIdCard(me.secretKey, me.publicKey, '', box, bid, ['wss://nos.lol']))).not.toBeNull();
  });

  it('a non-string name, a long name, 9 relays or a non-string relay are refused', () => {
    const c = makeIdCard(me.secretKey, me.publicKey, '', box, bid, ['wss://nos.lol']);
    expect(checkIdCard(id, resigned(c, { n: ['x'] }))).toBeNull();
    expect(checkIdCard(id, resigned(c, { n: 'n'.repeat(41) }))).toBeNull();
    expect(checkIdCard(id, resigned(c, { rr: Array.from({ length: 9 }, (_, i) => `wss://r${i}.example`) }))).toBeNull();
    expect(checkIdCard(id, resigned(c, { rr: ['wss://nos.lol', { url: 'wss://evil.example' }] }))).toBeNull();
    expect(checkIdCard(id, resigned(c, { rr: ['w'.repeat(300)] }))).toBeNull();
  });
});
