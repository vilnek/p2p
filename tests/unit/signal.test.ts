import { describe, expect, it } from 'vitest';
import { fromB64url, toB64url } from '../../src/core/bytes';
import { identityFromPhrase, newPhrase } from '../../src/core/identity';
import { decodeCode, encodeCode, makeCode, sdpFingerprint, verifyCode } from '../../src/core/signal';

const FP_A = Array.from({ length: 32 }, (_, i) => (i * 7).toString(16).padStart(2, '0').toUpperCase()).join(':');
const FP_EVIL = Array.from({ length: 32 }, (_, i) => (255 - i).toString(16).padStart(2, '0').toUpperCase()).join(':');
const sdp = (fp: string) =>
  `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:abcd\r\na=ice-pwd:abcdefghijklmnopqrstuvwx\r\na=fingerprint:sha-256 ${fp}\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\n`;

async function setup() {
  const alice = await identityFromPhrase(newPhrase());
  const eph = crypto.getRandomValues(new Uint8Array(32));
  const code = makeCode({ kind: 'offer', sdp: sdp(FP_A), identitySecret: alice.secretKey, identityPublic: alice.publicKey, ephemeralPublic: eph, name: 'Ravi' });
  return { alice, code };
}

describe('signed connection codes', () => {
  it('reads the DTLS fingerprint', () => {
    expect(sdpFingerprint(sdp(FP_A))).toBe(`sha-256 ${FP_A}`);
  });

  it('accepts a genuine code (and survives the text round trip)', async () => {
    const { alice, code } = await setup();
    const text = await encodeCode(code);
    expect(text.startsWith('P2P1.')).toBe(true);
    expect(text).toMatch(/^P2P1\.[A-Za-z0-9_-]+$/);
    const v = verifyCode(await decodeCode(text), 'offer');
    expect(v.identityKey).toEqual(alice.publicKey);
    expect(v.name).toBe('Ravi');
  });

  it('rejects a tampered signature', async () => {
    const { code } = await setup();
    const sig = fromB64url(code.g);
    sig[5] ^= 0x01;
    expect(() => verifyCode({ ...code, g: toB64url(sig) }, 'offer')).toThrow(/Safety check failed/);
  });

  it('rejects a swapped DTLS fingerprint (fake middleman)', async () => {
    const { code } = await setup();
    expect(() => verifyCode({ ...code, s: sdp(FP_EVIL) }, 'offer')).toThrow(/Safety check failed/);
  });

  it('rejects a middleman who signs with his own key but keeps the victim key', async () => {
    const { code } = await setup();
    const mallory = await identityFromPhrase(newPhrase());
    const forged = makeCode({ kind: 'offer', sdp: sdp(FP_EVIL), identitySecret: mallory.secretKey, identityPublic: mallory.publicKey, ephemeralPublic: fromB64url(code.e), name: 'Ravi' });
    expect(() => verifyCode({ ...forged, k: code.k }, 'offer')).toThrow(/Safety check failed/);
  });

  it('rejects a changed name or one-time key', async () => {
    const { code } = await setup();
    expect(() => verifyCode({ ...code, n: 'Mallory' }, 'offer')).toThrow();
    expect(() => verifyCode({ ...code, e: toB64url(new Uint8Array(32).fill(9)) }, 'offer')).toThrow();
  });

  it('binds an answer to the offer it replies to', async () => {
    const bob = await identityFromPhrase(newPhrase());
    const ans = makeCode({ kind: 'answer', sdp: sdp(FP_EVIL), identitySecret: bob.secretKey, identityPublic: bob.publicKey, ephemeralPublic: new Uint8Array(32).fill(1), name: '', peerFingerprint: `sha-256 ${FP_A}` });
    expect(() => verifyCode(ans, 'answer', `sha-256 ${FP_A}`)).not.toThrow();
    expect(() => verifyCode(ans, 'answer', `sha-256 ${FP_EVIL}`)).toThrow(/Safety check failed/);
    expect(() => verifyCode(ans, 'offer')).toThrow();
  });

  it('an offer bound to one reply box is refused for another box', async () => {
    const alice = await identityFromPhrase(newPhrase());
    const offer = makeCode({ kind: 'offer', sdp: sdp(FP_A), identitySecret: alice.secretKey, identityPublic: alice.publicKey, ephemeralPublic: new Uint8Array(32).fill(2), name: '', peerFingerprint: 'box:aa' });
    expect(() => verifyCode(offer, 'offer', 'box:aa')).not.toThrow();
    expect(() => verifyCode(offer, 'offer', 'box:bb')).toThrow(/Safety check failed/);
    expect(() => verifyCode(offer, 'offer')).toThrow(/Safety check failed/);
  });

  it('rejects damaged text', async () => {
    await expect(decodeCode('P2P1.abc')).rejects.toThrow();
    await expect(decodeCode('hello')).rejects.toThrow();
  });
});
