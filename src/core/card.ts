// One-scan connect: the small "connect card" in the QR / invite link, and the one-time reply box.
//
// Card (binary, then base64url), 149 bytes = 199 characters with the built-in relays:
//   [0]      version (high 4 bits = 1) | flags (bit 0: custom relay addresses follow,
//            bit 1: this is a 24-hour invite, bit 2: a short name follows)
//   [1]      relay hints: bit i = built-in relay i (DEFAULT_RELAYS)
//   [2..33]  identity public key (Ed25519)
//   [34..65] reply-box public key (X25519, fresh for this card)
//   [66..81] box id (16 random bytes)
//   [82..84] expiry, minutes since 2026-01-01 UTC (3 bytes, big-endian)
//   [...]    if flag 0: count, then (length, UTF-8 address) per custom relay
//   [...]    if flag 2: length, UTF-8 name (at most 16 bytes; invites only, for "Connecting to Dr Vijay…")
//   [-64..]  Ed25519 signature by the identity key over "p2ptalk-card-v1" || everything above
//
// The 10-minute QR card has no name (to keep the QR small); it travels inside the locked, signed
// offer/answer. An invite card (same layout, flag 1) also carries a short name, and its box key is kept
// on the device until the invite expires, so it works when the sender is offline.

import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { concat, equal, fromB64url, fromUtf8, toB64url, toHex, utf8 } from './bytes';
import { sign, verify } from './identity';

/**
 * Built-in public relays (only used to pass the two small locked connection messages).
 * Keep in sync with connect-src in p2p.html (a unit test checks this).
 */
export const DEFAULT_RELAYS: readonly string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
  'wss://nostr.mom',
];

export const INVITE_BASE = 'https://p2p.vilnek.in/#c=';
export const CARD_TTL_MS = 10 * 60 * 1000;
export const INVITE_TTL_MS = 24 * 3600 * 1000;
export const INVITE_USED_TEXT = 'This invite has expired or was already used. Ask for a new one.';
const EPOCH_MS = Date.UTC(2026, 0, 1);
const VERSION = 1;
const SIG_LEN = 64;
const HEADER_LEN = 2 + 32 + 32 + 16 + 3;

export interface Card {
  kind: 'scan' | 'invite';
  /** Sender's short name (invites only). */
  name: string;
  identityKey: Uint8Array;
  boxKey: Uint8Array;
  boxId: Uint8Array;
  /** Expiry time (ms since 1970). */
  expires: number;
  /** Relay addresses (built-in and custom). */
  relays: string[];
}

export class CardError extends Error {}

function body(card: Card): Uint8Array {
  const mask = card.relays.reduce((m, r) => (DEFAULT_RELAYS.includes(r) ? m | (1 << DEFAULT_RELAYS.indexOf(r)) : m), 0);
  const custom = card.relays.filter((r) => !DEFAULT_RELAYS.includes(r)).map(utf8);
  if (custom.some((c) => c.length > 255) || custom.length > 8) throw new CardError('Relay address too long.');
  const minutes = Math.ceil((card.expires - EPOCH_MS) / 60000);
  const name = shortName(card.name);
  const head = new Uint8Array(HEADER_LEN);
  head[0] = (VERSION << 4) | (custom.length ? 1 : 0) | (card.kind === 'invite' ? 2 : 0) | (name.length ? 4 : 0);
  head[1] = mask;
  head.set(card.identityKey, 2);
  head.set(card.boxKey, 34);
  head.set(card.boxId, 66);
  head[82] = (minutes >> 16) & 0xff;
  head[83] = (minutes >> 8) & 0xff;
  head[84] = minutes & 0xff;
  const parts: Uint8Array[] = [head];
  if (custom.length) parts.push(Uint8Array.of(custom.length), ...custom.flatMap((c) => [Uint8Array.of(c.length), c]));
  if (name.length) parts.push(Uint8Array.of(name.length), name);
  return concat(...parts);
}

/** At most 16 UTF-8 bytes, cut on a character boundary. */
function shortName(name: string): Uint8Array {
  let out = '';
  for (const ch of name.trim()) {
    if (utf8(out + ch).length > 16) break;
    out += ch;
  }
  return utf8(out);
}

const signed = (b: Uint8Array) => concat(utf8('p2ptalk-card-v1'), b);

/**
 * A new card with a fresh one-time reply box. QR card: keep `boxSecret` in memory only.
 * Invite (`opts.invite`): longer life and a short name; the box secret is kept on the device.
 */
export function newCard(
  identitySecret: Uint8Array,
  identityPublic: Uint8Array,
  relays: string[],
  now = Date.now(),
  opts: { invite?: boolean; ttlMs?: number; name?: string } = {},
) {
  const boxSecret = x25519.utils.randomPrivateKey();
  const ttl = opts.ttlMs ?? (opts.invite ? INVITE_TTL_MS : CARD_TTL_MS);
  const card: Card = {
    kind: opts.invite ? 'invite' : 'scan',
    name: opts.invite ? fromUtf8(shortName(opts.name ?? '')) : '',
    identityKey: identityPublic,
    boxKey: x25519.getPublicKey(boxSecret),
    boxId: crypto.getRandomValues(new Uint8Array(16)),
    expires: EPOCH_MS + Math.ceil((now + ttl - EPOCH_MS) / 60000) * 60000,
    relays,
  };
  const b = body(card);
  const text = toB64url(concat(b, sign(identitySecret, signed(b))));
  return { card, boxSecret, text, link: INVITE_BASE + text };
}

/** Pulls the card text out of a link, "#c=…", or the bare text. Returns null if it isn't one. */
export function cardTextFrom(input: string): string | null {
  const t = input.trim();
  const m = /[#&?]c=([A-Za-z0-9_-]+)/.exec(t);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{150,600}$/.test(t) ? t : null;
}

/** Reads and checks a card: version, signature and expiry. Throws a plain-words error. */
export function decodeCard(text: string, now = Date.now()): Card {
  let raw: Uint8Array;
  try {
    raw = fromB64url(text);
  } catch {
    throw new CardError('This code is damaged.');
  }
  if (raw.length < HEADER_LEN + SIG_LEN) throw new CardError('This code is incomplete. Copy all of it.');
  if (raw[0] >> 4 !== VERSION) throw new CardError('This code is from a different version of the app.');
  const b = raw.subarray(0, raw.length - SIG_LEN);
  const sig = raw.subarray(raw.length - SIG_LEN);
  const identityKey = b.slice(2, 34);
  if (!verify(identityKey, signed(b), sig)) throw new CardError('Safety check failed: this code was changed. Not connecting.');
  const relays = DEFAULT_RELAYS.filter((_, i) => b[1] & (1 << i));
  let o = HEADER_LEN;
  // The same limits as body(): at most 8 custom relays and a 16-byte name; nothing past the signed bytes.
  const damaged = () => new CardError('This code is damaged.');
  if (b[0] & 1) {
    const n = b[o++];
    if (n > 8) throw damaged();
    for (let i = 0; i < n; i++) {
      const len = b[o++];
      if (o + len > b.length) throw damaged();
      relays.push(fromUtf8(b.subarray(o, o + len)));
      o += len;
    }
  }
  let name = '';
  if (b[0] & 4) {
    const len = b[o++];
    if (len > 16 || o + len > b.length) throw damaged();
    name = fromUtf8(b.subarray(o, o + len));
    o += len;
  }
  if (o !== b.length) throw damaged();
  const kind = b[0] & 2 ? 'invite' : 'scan';
  const minutes = (b[82] << 16) | (b[83] << 8) | b[84];
  const expires = EPOCH_MS + minutes * 60000;
  if (now > expires + 60_000) {
    throw new CardError(kind === 'invite' ? INVITE_USED_TEXT : 'This code has expired. Ask them to show a new one.');
  }
  return { kind, name, identityKey, boxKey: b.slice(34, 66), boxId: b.slice(66, 82), expires, relays };
}

// ---- The one-time reply box --------------------------------------------------------------------
// B -> A: X25519(fresh key, box key) -> HKDF -> AES-256-GCM.  A -> B: same secret, other HKDF label.

export const offerTag = (boxId: Uint8Array) => toHex(sha256(boxId));
export const replyTag = (boxId: Uint8Array) => toHex(sha256(concat(boxId, utf8('reply'))));

async function boxKey(shared: Uint8Array, boxId: Uint8Array, boxPub: Uint8Array, sealPub: Uint8Array, dir: 'offer' | 'reply') {
  if (shared.every((x) => x === 0)) throw new CardError('bad key');
  const raw = hkdf(sha256, shared, boxId, concat(utf8(`p2ptalk-box-v1 ${dir}`), boxPub, sealPub), 32);
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const aad = (boxId: Uint8Array, boxPub: Uint8Array, sealPub: Uint8Array, dir: string) =>
  concat(utf8(`p2ptalk-box-v1 ${dir}`), boxId, boxPub, sealPub) as BufferSource;

async function aes(key: CryptoKey, plain: Uint8Array, ad: BufferSource): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, key, plain as BufferSource);
  return concat(iv, new Uint8Array(ct));
}

async function unaes(key: CryptoKey, blob: Uint8Array, ad: BufferSource): Promise<Uint8Array> {
  if (blob.length < 12 + 16) throw new CardError('too short');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(0, 12) as BufferSource, additionalData: ad }, key, blob.subarray(12) as BufferSource));
}

/** B: lock a message to A's reply box. Output: fresh public key (32) || nonce (12) || ciphertext. */
export async function sealToBox(card: Pick<Card, 'boxKey' | 'boxId'>, plain: Uint8Array) {
  const sealSecret = x25519.utils.randomPrivateKey();
  const sealPub = x25519.getPublicKey(sealSecret);
  const key = await boxKey(x25519.getSharedSecret(sealSecret, card.boxKey), card.boxId, card.boxKey, sealPub, 'offer');
  const blob = concat(sealPub, await aes(key, plain, aad(card.boxId, card.boxKey, sealPub, 'offer')));
  return { sealSecret, sealPub, blob };
}

/** A: open a message sent to its box. Throws if it wasn't locked to this box. */
export async function openBox(boxSecret: Uint8Array, boxId: Uint8Array, blob: Uint8Array) {
  if (blob.length < 32 + 12 + 16) throw new CardError('too short');
  const boxPub = x25519.getPublicKey(boxSecret);
  const sealPub = blob.slice(0, 32);
  const key = await boxKey(x25519.getSharedSecret(boxSecret, sealPub), boxId, boxPub, sealPub, 'offer');
  return { sealPub, plain: await unaes(key, blob.subarray(32), aad(boxId, boxPub, sealPub, 'offer')) };
}

/** A: lock the reply to B's fresh key. */
export async function sealReply(boxSecret: Uint8Array, boxId: Uint8Array, sealPub: Uint8Array, plain: Uint8Array) {
  const boxPub = x25519.getPublicKey(boxSecret);
  const key = await boxKey(x25519.getSharedSecret(boxSecret, sealPub), boxId, boxPub, sealPub, 'reply');
  return aes(key, plain, aad(boxId, boxPub, sealPub, 'reply'));
}

/** B: open A's reply. */
export async function openReply(sealSecret: Uint8Array, card: Pick<Card, 'boxKey' | 'boxId'>, blob: Uint8Array) {
  const sealPub = x25519.getPublicKey(sealSecret);
  const key = await boxKey(x25519.getSharedSecret(sealSecret, card.boxKey), card.boxId, card.boxKey, sealPub, 'reply');
  return unaes(key, blob, aad(card.boxId, card.boxKey, sealPub, 'reply'));
}

export const sameKey = equal;
