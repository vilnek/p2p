import { describe, expect, it } from 'vitest';
import { toB64url } from '../../src/core/bytes';
import { certify, defaultDeviceName, deviceCode, deviceProof, newDevice, renameDevice, verifyCert, verifyDeviceProof } from '../../src/core/device';
import { identityFromPhrase, newPhrase, p2pId } from '../../src/core/identity';
import { fromUtf8, utf8 } from '../../src/core/bytes';
import { openPairNote, pairKeys, pairTag, sealPairNote } from '../../src/core/pair';

describe('device keys and certificates (same 24 words on several devices)', () => {
  it('two devices of one account: same ID, different device keys, both certificates check', async () => {
    const phrase = newPhrase();
    const [x, y] = await Promise.all([identityFromPhrase(phrase), identityFromPhrase(phrase)]);
    expect(p2pId(x.publicKey)).toBe(p2pId(y.publicKey));
    const phone = newDevice(x.secretKey, x.publicKey, 'iPhone');
    const mac = newDevice(y.secretKey, y.publicKey, 'Mac');
    expect(toB64url(phone.publicKey)).not.toBe(toB64url(mac.publicKey));
    expect(verifyCert(x.publicKey, phone.cert)).toEqual({ key: toB64url(phone.publicKey), name: 'iPhone', created: phone.created });
    expect(verifyCert(x.publicKey, mac.cert)?.name).toBe('Mac');
  });

  it('rejects a certificate from another identity, a changed name and a damaged key', async () => {
    const [a, b] = await Promise.all([identityFromPhrase(newPhrase()), identityFromPhrase(newPhrase())]);
    const d = newDevice(a.secretKey, a.publicKey, 'iPhone');
    expect(verifyCert(b.publicKey, d.cert)).toBeNull();
    expect(verifyCert(a.publicKey, { ...d.cert, dn: 'Mac' })).toBeNull();
    expect(verifyCert(a.publicKey, { ...d.cert, dk: 'AAAA' })).toBeNull();
    expect(verifyCert(a.publicKey, null)).toBeNull();
    // A forged certificate made with someone else's identity key for a's ID: rejected.
    const forged = certify(b.secretKey, a.publicKey, d.publicKey, 'Evil', 1);
    expect(verifyCert(a.publicKey, forged)).toBeNull();
  });

  it('rename keeps the device key; the new certificate checks', async () => {
    const a = await identityFromPhrase(newPhrase());
    const d = newDevice(a.secretKey, a.publicKey, 'Chrome on Mac');
    const r = renameDevice(a.secretKey, a.publicKey, d, '  Clinic   Mac ');
    expect(r.publicKey).toEqual(d.publicKey);
    expect(r.name).toBe('Clinic Mac');
    expect(verifyCert(a.publicKey, r.cert)?.name).toBe('Clinic Mac');
    expect(deviceCode(r.publicKey)).toMatch(/^[0-9A-F]{4} [0-9A-F]{4}$/);
  });

  it('the hello proof binds the device key to this connection (both fingerprints)', async () => {
    const a = await identityFromPhrase(newPhrase());
    const d = newDevice(a.secretKey, a.publicKey, 'iPhone');
    const proof = deviceProof(d.secretKey, 'sha-256 AA', 'sha-256 BB');
    const key = toB64url(d.publicKey);
    expect(verifyDeviceProof(key, proof, 'sha-256 AA', 'sha-256 BB')).toBe(true);
    expect(verifyDeviceProof(key, proof, 'sha-256 BB', 'sha-256 AA')).toBe(false);
    expect(verifyDeviceProof(key, proof, 'sha-256 AA', 'sha-256 CC')).toBe(false);
    expect(verifyDeviceProof(key, undefined, 'sha-256 AA', 'sha-256 BB')).toBe(false);
  });

  it('default device names from the platform', () => {
    expect(defaultDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iPhone');
    expect(defaultDeviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36')).toBe('Android phone');
    expect(defaultDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')).toBe('Chrome on Mac');
    expect(defaultDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe('Mac');
    expect(defaultDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 5)).toBe('iPad');
    expect(defaultDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0')).toBe('Edge on Windows');
  });
});

describe('"taken" note on the pair topic (first device wins)', () => {
  it('opens on every device of both people, not for anyone else', async () => {
    const phrase = newPhrase();
    const [mine1, mine2, ravi, other] = await Promise.all([identityFromPhrase(phrase), identityFromPhrase(phrase), identityFromPhrase(newPhrase()), identityFromPhrase(newPhrase())]);
    const fromRavi = pairKeys(ravi.secretKey, ravi.publicKey, mine1.publicKey);
    const note = await sealPairNote(fromRavi, utf8(JSON.stringify({ t: 'taken', a: 'x', d: 'k' })));
    for (const dev of [mine1, mine2]) {
      const k = pairKeys(dev.secretKey, dev.publicKey, ravi.publicKey);
      expect(JSON.parse(fromUtf8(await openPairNote(k, note))).t).toBe('taken');
    }
    const outsider = pairKeys(other.secretKey, other.publicKey, ravi.publicKey);
    await expect(openPairNote(outsider, note)).rejects.toThrow();
    expect(pairTag(fromRavi.secret, 'taken', 1)).not.toBe(pairTag(fromRavi.secret, 'offer', 1));
  });
});
