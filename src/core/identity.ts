// Identity: 24-word recovery phrase -> Ed25519 identity key -> 24-digit P2P ID and emoji code.
// Plan §5.2 and §5.3.

import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { ed25519, edwardsToMontgomeryPriv, edwardsToMontgomeryPub } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { concat, utf8 } from './bytes';
import { dammDigit, dammValid } from './damm';
import { EMOJI_256 } from './emoji';

export interface Identity {
  /** Ed25519 private key (32 bytes). */
  secretKey: Uint8Array;
  /** Ed25519 public key (32 bytes): the real "you". */
  publicKey: Uint8Array;
}

/** A new 24-word phrase from 256 bits of strong randomness. */
export function newPhrase(): string {
  return generateMnemonic(wordlist, 256);
}

/** Tidy what a person typed: lower case, single spaces. */
/**
 * Lower case, single spaces. Also reads the words as Copy gives them: a "P2P Talk: …" heading line and
 * numbers ("1. apple", "2) river", one per line) are dropped. The 24 words themselves are letters only.
 */
export function normalisePhrase(phrase: string): string {
  return phrase
    .toLowerCase()
    .split(/\r?\n/)
    .filter((line) => !/^\s*p2p talk\b/.test(line))
    .join(' ')
    .split(/\s+/)
    .map((w) => w.replace(/^#?\d+[.):-]*/, '').replace(/[.,;:]+$/, ''))
    .filter(Boolean)
    .join(' ');
}

export function phraseIsValid(phrase: string): boolean {
  const p = normalisePhrase(phrase);
  return p.split(' ').length === 24 && validateMnemonic(p, wordlist);
}

/** Phrase -> BIP-39 seed (PBKDF2, empty passphrase) -> HKDF-SHA256("p2ptalk-identity-v1") -> Ed25519 key. */
export async function identityFromPhrase(phrase: string): Promise<Identity> {
  const p = normalisePhrase(phrase);
  if (!phraseIsValid(p)) throw new Error('These 24 words are not right. Check each word.');
  const seed = await mnemonicToSeed(p);
  return identityFromSeed(seed);
}

export function identityFromSeed(seed: Uint8Array): Identity {
  const secretKey = hkdf(sha256, seed, undefined, utf8('p2ptalk-identity-v1'), 32);
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

/** The 24-digit P2P ID (digits only, no spaces). */
export function p2pId(publicKey: Uint8Array): string {
  const h = sha256(concat(utf8('p2ptalk-id-v1'), publicKey));
  let n = 0n;
  for (let i = 0; i < 10; i++) n = (n << 8n) | BigInt(h[i]);
  const body = (n % 10n ** 23n).toString().padStart(23, '0');
  return body + dammDigit(body);
}

/** "4821 0937 6612 3390 7745 1208" */
export function formatId(id: string): string {
  return id.replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');
}

/** Checks a typed ID: 24 digits and a correct check digit. */
export function idIsValid(id: string): boolean {
  const d = id.replace(/[\s-]/g, '');
  return /^\d{24}$/.test(d) && dammValid(d);
}

/** 4 emoji from SHA-256("p2ptalk-emoji-v1" || public key), to compare in person or on a call. */
export function emojiCode(publicKey: Uint8Array, count = 4): string {
  const h = sha256(concat(utf8('p2ptalk-emoji-v1'), publicKey));
  return Array.from(h.subarray(0, count), (b) => EMOJI_256[b]).join('');
}

// ---- Signatures and key agreement --------------------------------------------------------

export function sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

export function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** The X25519 form of an Ed25519 key pair (the standard birational map). */
export const x25519SecretFromEd = (edSecret: Uint8Array): Uint8Array => edwardsToMontgomeryPriv(edSecret);
export const x25519PublicFromEd = (edPublic: Uint8Array): Uint8Array => edwardsToMontgomeryPub(edPublic);

/** "Join as guest": a random identity key with no 24 words (this browser only). */
export function newGuestIdentity(): Identity {
  const secretKey = ed25519.utils.randomPrivateKey();
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}
