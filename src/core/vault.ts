// Secrets at rest (security review M-1): the identity key, device key, group keys, invite and reply
// box secrets and the waiting 24 words are kept in IndexedDB SEALED with AES-256-GCM under a
// NON-EXTRACTABLE WebCrypto key that this browser made and keeps in the same database (IndexedDB
// stores a CryptoKey by structured clone, and it stays non-extractable).
//
// What it stops: copying the database files (a backup, a forensic image, another app reading the
// profile or the phone's app folder) gives sealed bytes only; the key itself can't be read out of the
// browser, only used inside it. What it does not stop: a script running inside this origin can still
// ASK the browser to open them (see the content policy, M-3). The phone apps should later wrap this key
// with the Android Keystore / iOS Keychain (a small native plugin); until then this is the same sealing.
//
// Format of a sealed value: { sealed: 1, iv: Uint8Array(12), ct: Uint8Array }
//   ct  = AES-256-GCM(key, iv, aad = utf8("p2ptalk-vault-v1 " + slot), utf8(JSON(value)))
//   Uint8Array values inside are written as {"$u8": base64url}. The slot name in the aad stops a sealed
//   value being moved to another slot (e.g. a group key read as the identity).

import { fromB64url, fromUtf8, toB64url, utf8 } from './bytes';

export interface Sealed {
  sealed: 1;
  iv: Uint8Array;
  ct: Uint8Array;
}

export const isSealed = (v: unknown): v is Sealed =>
  !!v && typeof v === 'object' && (v as Sealed).sealed === 1 && (v as Sealed).iv instanceof Uint8Array && (v as Sealed).ct instanceof Uint8Array;

/** A new sealing key: AES-256-GCM, usable here, never readable (extractable: false). */
export function newVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}

const aad = (slot: string) => utf8(`p2ptalk-vault-v1 ${slot}`);

/** JSON with Uint8Array values kept (as {"$u8": base64url}). Also used by the chat lock (core/chatlock.ts). */
export function encode(value: unknown): Uint8Array {
  return utf8(JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? { $u8: toB64url(v) } : v)));
}

export function decode(bytes: Uint8Array): unknown {
  return JSON.parse(fromUtf8(bytes), (_k, v) => (v && typeof v === 'object' && typeof v.$u8 === 'string' && Object.keys(v).length === 1 ? fromB64url(v.$u8) : v));
}

export async function sealValue(key: CryptoKey, slot: string, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(slot) as BufferSource }, key, encode(value) as BufferSource));
  return { sealed: 1, iv, ct };
}

export class VaultError extends Error {
  constructor() {
    super('The keys stored on this device could not be opened.');
    this.name = 'VaultError';
  }
}

export async function openValue<T = unknown>(key: CryptoKey, slot: string, s: Sealed): Promise<T> {
  let pt: ArrayBuffer;
  try {
    pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: s.iv as BufferSource, additionalData: aad(slot) as BufferSource }, key, s.ct as BufferSource);
  } catch {
    throw new VaultError(); // never "no account": that would invite making a new one over it
  }
  return decode(new Uint8Array(pt)) as T;
}

/**
 * Reads one stored secret. Sealed: opened. Stored by an older version (plain): returned as it is and
 * sealed in place (`resave`), so existing data moves over on first use. Missing: undefined.
 */
export async function openOrMigrate<T>(key: CryptoKey | null, slot: string, raw: unknown, resave: (s: Sealed) => Promise<unknown>): Promise<T | undefined> {
  if (raw === undefined || raw === null) return undefined;
  if (isSealed(raw)) {
    if (!key) throw new VaultError();
    return openValue<T>(key, slot, raw);
  }
  if (key) await resave(await sealValue(key, slot, raw)).catch(() => undefined);
  return raw as T;
}
