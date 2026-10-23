// Security review 2026-10, M-1: secrets sealed at rest under a non-extractable key (core/vault.ts).
import { describe, expect, it } from 'vitest';
import { fromUtf8 } from '../../src/core/bytes';
import { VaultError, isSealed, newVaultKey, openOrMigrate, openValue, sealValue, type Sealed } from '../../src/core/vault';

const me = () => ({ secretKey: crypto.getRandomValues(new Uint8Array(32)), publicKey: crypto.getRandomValues(new Uint8Array(32)), name: 'Dr V', created: 1 });

describe('vault: sealing stored secrets (M-1)', () => {
  it('the key cannot be read out, also after a structured clone (how IndexedDB keeps it)', async () => {
    const k = await newVaultKey();
    expect(k.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', k)).rejects.toThrow();
    const copy = structuredClone(k);
    expect(copy.extractable).toBe(false);
    const s = await sealValue(k, 'me', { a: 1 });
    expect(await openValue(copy, 'me', s)).toEqual({ a: 1 });
  });

  it('round trip keeps byte arrays; the sealed form holds no plain secret', async () => {
    const k = await newVaultKey();
    const m = me();
    const s = await sealValue(k, 'me', m);
    expect(isSealed(s)).toBe(true);
    const asText = fromUtf8(s.ct);
    expect(asText).not.toContain('Dr V');
    const back = await openValue<typeof m>(k, 'me', s);
    expect(back.secretKey).toBeInstanceOf(Uint8Array);
    expect(back.secretKey).toEqual(m.secretKey);
    expect(back).toEqual(m);
    // Two seals of the same value differ (fresh nonce).
    expect((await sealValue(k, 'me', m)).iv).not.toEqual(s.iv);
  });

  it('a sealed value opens only in its own slot, with its own key, unchanged', async () => {
    const k = await newVaultKey();
    const s = await sealValue(k, 'groups', { keys: ['x'] });
    await expect(openValue(k, 'me', s)).rejects.toBeInstanceOf(VaultError);
    await expect(openValue(await newVaultKey(), 'groups', s)).rejects.toBeInstanceOf(VaultError);
    const bad: Sealed = { ...s, ct: s.ct.slice() };
    bad.ct[0] ^= 1;
    await expect(openValue(k, 'groups', bad)).rejects.toBeInstanceOf(VaultError);
  });

  it('migration: a value stored by an older version is returned and sealed in place', async () => {
    const k = await newVaultKey();
    const m = me();
    let saved: unknown;
    const got = await openOrMigrate(k, 'me', m, async (s) => (saved = s));
    expect(got).toEqual(m);
    expect(isSealed(saved)).toBe(true);
    expect(await openValue(k, 'me', saved as Sealed)).toEqual(m);
    // Next read: sealed, opened, nothing re-saved.
    let again = false;
    expect(await openOrMigrate(k, 'me', saved, async () => (again = true))).toEqual(m);
    expect(again).toBe(false);
    // Missing stays missing; a sealed value with no key is an error, never "no account".
    expect(await openOrMigrate(k, 'me', undefined, async () => undefined)).toBeUndefined();
    await expect(openOrMigrate(null, 'me', saved, async () => undefined)).rejects.toBeInstanceOf(VaultError);
  });
});
