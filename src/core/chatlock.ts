// Chat lock (plan §8.7, security review I-1): locked chats are stored SEALED with a key that only the
// secret code opens. One code for all locked chats on this device (like WhatsApp's).
//
//   wrap key   = HKDF-SHA256( Argon2id(code, salt16, m = 64 MiB, t = 3, p = 1) ‖ device secret,
//                             salt = salt16, info = "p2ptalk-chatlock-v1 wrap" )        → AES-256-GCM
//   lock key   = a P-256 key pair made when the code is set; its private half is kept sealed with the
//                wrap key (AES-GCM, aad "p2ptalk-chatlock-v1 key"). Wrong code → the seal doesn't open.
//   a message  = sealed TO the lock's public key: a fresh P-256 key per message, ECDH, HKDF-SHA256
//                (salt = their public ‖ lock public, info "p2ptalk-chatlock-v1 msg") → AES-256-GCM with
//                aad "p2ptalk-chatlock-v1 <chat id>" (a sealed message can't be moved to another chat).
//
// Why a key pair: messages that arrive while the chats are locked are sealed at once with the public
// half, without the code; reading them needs the private half, so the code. The device secret (32 random
// bytes, kept sealed by the vault, core/vault.ts) means a copy of the stored lock alone can't be guessed
// offline; the phone apps should later keep it in the Keystore / Keychain (review I-1).
//
// Argon2id runs in WebAssembly (hash-wasm, MIT; ~0.2 s). Where WebAssembly can't run (an old web view
// without 'wasm-unsafe-eval'), the same Argon2id runs in plain JavaScript (@noble/hashes; slower, the
// same result: tests/unit/chatlock.test.ts checks both give the same bytes).

import { argon2id as argon2Wasm } from 'hash-wasm';
import { argon2idAsync as argon2Js } from '@noble/hashes/argon2';
import { concat, utf8 } from './bytes';
import { decode, encode } from './vault';

/** The review's Argon2id parameters (m in KiB). */
export const ARGON2 = { m: 65536, t: 3, p: 1 } as const;
export interface Argon2Params {
  m: number;
  t: number;
  p: number;
}

/** What is stored for the lock (itself kept sealed by the vault in the 'chatLock' slot). */
export interface LockRecord {
  v: 1;
  salt: Uint8Array;
  params: Argon2Params;
  /** The lock's public key (P-256, raw, 65 bytes). */
  pub: Uint8Array;
  /** Its private key (PKCS #8), sealed with the wrap key. */
  iv: Uint8Array;
  wrapped: Uint8Array;
  /** Locked chats: contact P2P IDs and "g:<group id>". */
  chats: string[];
  set: number;
}

/** One sealed value (a message's contents). */
export interface Box {
  e: Uint8Array;
  iv: Uint8Array;
  ct: Uint8Array;
}

/** The lock, opened with the code: can read sealed messages. */
export interface OpenLock {
  priv: CryptoKey;
  pub: Uint8Array;
}

export class WrongCode extends Error {
  constructor() {
    super('Wrong code.');
    this.name = 'WrongCode';
  }
}

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;
const AAD_KEY = utf8('p2ptalk-chatlock-v1 key');
const aadChat = (chat: string) => utf8(`p2ptalk-chatlock-v1 ${chat}`);
const buf = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

/** A secret code is at least 4 digits, or a passphrase of 6 or more characters. null = fine. */
export function codeProblem(code: string): string | null {
  if (/^\d+$/.test(code)) return code.length >= 4 ? null : 'Use at least 4 digits.';
  return code.length >= 6 ? null : 'Use at least 4 digits, or 6 or more letters and numbers.';
}

/** Argon2id (WebAssembly, or plain JavaScript where WebAssembly can't run). */
export async function argon2(code: string, salt: Uint8Array, params: Argon2Params): Promise<Uint8Array> {
  const password = utf8(code.normalize('NFC'));
  try {
    return await argon2Wasm({ password, salt, iterations: params.t, memorySize: params.m, parallelism: params.p, hashLength: 32, outputType: 'binary' });
  } catch {
    return argon2Js(password, salt, { t: params.t, m: params.m, p: params.p, dkLen: 32 });
  }
}

async function hkdfKey(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(utf8(info)) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** The wrap key from the code (slow on purpose: Argon2id) and this device's secret. */
export async function wrapKey(code: string, salt: Uint8Array, params: Argon2Params, deviceSecret: Uint8Array): Promise<CryptoKey> {
  const a = await argon2(code, salt, params);
  try {
    return await hkdfKey(concat(a, deviceSecret), salt, 'p2ptalk-chatlock-v1 wrap');
  } finally {
    a.fill(0);
  }
}

/** A new lock for this code: a new key pair, its private half sealed with the code. */
export async function newLock(code: string, deviceSecret: Uint8Array, chats: string[] = [], params: Argon2Params = ARGON2): Promise<{ record: LockRecord; open: OpenLock }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const pair = (await crypto.subtle.generateKey(P256, true, ['deriveBits'])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const k = await wrapKey(code, salt, params, deviceSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: buf(AAD_KEY) }, k, buf(pkcs8)));
  // The private key in use is a fresh, non-extractable copy.
  const priv = await crypto.subtle.importKey('pkcs8', buf(pkcs8), P256, false, ['deriveBits']);
  pkcs8.fill(0);
  return { record: { v: 1, salt, params: { ...params }, pub, iv, wrapped, chats: [...chats], set: Date.now() }, open: { priv, pub } };
}

/** Opens the lock with the code. Throws WrongCode. */
export async function openLock(r: LockRecord, code: string, deviceSecret: Uint8Array): Promise<OpenLock> {
  const k = await wrapKey(code, r.salt, r.params, deviceSecret);
  let pkcs8: Uint8Array;
  try {
    pkcs8 = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(r.iv), additionalData: buf(AAD_KEY) }, k, buf(r.wrapped)));
  } catch {
    throw new WrongCode();
  }
  try {
    const priv = await crypto.subtle.importKey('pkcs8', buf(pkcs8), P256, false, ['deriveBits']);
    return { priv, pub: r.pub };
  } finally {
    pkcs8.fill(0);
  }
}

const pubKeys = new Map<string, Promise<CryptoKey>>();
function importPub(raw: Uint8Array): Promise<CryptoKey> {
  const id = Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
  let k = pubKeys.get(id);
  if (!k) {
    k = crypto.subtle.importKey('raw', buf(raw), P256, false, []);
    pubKeys.set(id, k);
  }
  return k;
}

async function boxKey(priv: CryptoKey, theirPub: CryptoKey, e: Uint8Array, lockPub: Uint8Array): Promise<CryptoKey> {
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: theirPub }, priv, 256));
  try {
    return await hkdfKey(shared, concat(e, lockPub), 'p2ptalk-chatlock-v1 msg');
  } finally {
    shared.fill(0);
  }
}

/** Seals a value for a locked chat (needs only the public key: works while the chats are locked). */
export async function seal(lockPub: Uint8Array, chat: string, value: unknown): Promise<Box> {
  const eph = (await crypto.subtle.generateKey(P256, true, ['deriveBits'])) as CryptoKeyPair;
  const e = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const k = await boxKey(eph.privateKey, await importPub(lockPub), e, lockPub);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: buf(aadChat(chat)) }, k, buf(encode(value))));
  return { e, iv, ct };
}

/** Opens a sealed value (needs the opened lock). Throws WrongCode if it doesn't open. */
export async function unseal<T = unknown>(open: OpenLock, chat: string, b: Box): Promise<T> {
  try {
    const k = await boxKey(open.priv, await crypto.subtle.importKey('raw', buf(b.e), P256, false, []), b.e, open.pub);
    return decode(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(b.iv), additionalData: buf(aadChat(chat)) }, k, buf(b.ct)))) as T;
  } catch {
    throw new WrongCode();
  }
}

export const isBox = (v: unknown): v is Box =>
  !!v && typeof v === 'object' && (v as Box).e instanceof Uint8Array && (v as Box).iv instanceof Uint8Array && (v as Box).ct instanceof Uint8Array;

// ---- file bytes kept in the database (small files in browsers without a private file area) ----------

/** Seals a file's bytes with a fresh key (the key goes inside the sealed message). */
export async function sealBytes(data: Uint8Array): Promise<{ fk: Uint8Array; sealed: Uint8Array }> {
  const fk = crypto.getRandomValues(new Uint8Array(32));
  const k = await crypto.subtle.importKey('raw', buf(fk), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, buf(data)));
  return { fk, sealed: concat(iv, ct) };
}

export async function openBytes(fk: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', buf(fk), 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(sealed.subarray(0, 12)) }, k, buf(sealed.subarray(12))));
}

// ---- wrong codes: a wait that grows (no wipe) --------------------------------------------------------

const WAITS = [0, 1, 2, 5, 10, 30, 60];
/** Seconds to wait after `fails` wrong codes in a row: 1, 2, 5, 10, 30, 60 s, then 5 minutes. */
export function waitAfter(fails: number): number {
  if (fails <= 0) return 0;
  return fails < WAITS.length ? WAITS[fails] : 300;
}
