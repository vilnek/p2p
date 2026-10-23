// Reconnecting two contacts through the relays, privately.
//
//   pair secret = HKDF(X25519(my identity, their identity), both keys sorted)   (only the two of them can compute it)
//   inbox key   = HKDF(pair secret, "inbox" ‖ the RECEIVER's identity key)      (one per direction, security review H-3)
//   tags        = HKDF(inbox key of the receiver, "offer"/"reply"/"taken" + hour number)
//                 (change every hour; outsiders can't compute them or link two hours). Each side listens
//                 only on tags made from its OWN inbox key and posts on the other's, so two contacts never
//                 subscribe to the same filter: a relay that logs REQ filters can't pair them up. It can
//                 only link them at the moment one of them actually posts an offer.
//                 Transition (until LEGACY_PAIR_TAGS_UNTIL): offers and "taken" notes are also posted on
//                 the old shared tags and replies are also read there (only during my own attempt), so
//                 contacts on an older version still connect. The old shared OFFER tags are never
//                 subscribed to: that subscription is what showed the contact graph.
//   offer lock  = X25519(fresh key, their identity) || pair secret -> HKDF -> AES-256-GCM
//   reply lock  = X25519(fresh key, offer's fresh key) || pair secret -> HKDF -> AES-256-GCM
//   note lock   = HKDF(pair secret, "note") -> AES-256-GCM     (short notes such as "taken", for all of
//                                                              both people's devices; no network addresses)
// The fresh keys are thrown away after use, so a later leak of an identity key doesn't open old
// offers/replies (which carry network addresses).

import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { concat, toHex, utf8 } from './bytes';
import { x25519PublicFromEd, x25519SecretFromEd } from './identity';

const HOUR_MS = 3600_000;

/**
 * Until then (1 Nov 2026, about a week after the change) reconnects also use the old shared tags for
 * posting, so contacts who have not reloaded yet still connect. Never used for subscribing to offers.
 */
export const LEGACY_PAIR_TAGS_UNTIL = Date.UTC(2026, 10, 1);

export interface PairKeys {
  /** MY inbox tag key: I listen on tags made from it (offers, replies and notes sent to me). Differs on the two sides. */
  secret: Uint8Array;
  /** THEIR inbox tag key (= their `secret`): I post on tags made from it. */
  out: Uint8Array;
  /** 32-byte secret both contacts share: locks only (and the old shared tags during the transition). */
  shared: Uint8Array;
  /** 16-byte id derived from the shared secret (binds signatures to this pair). */
  id: Uint8Array;
  /** False for group-member pairs (new in Oct 2026): no old shared tags to keep posting on. */
  legacy?: boolean;
}

const inboxKey = (shared: Uint8Array, receiverPublicEd: Uint8Array) => hkdf(sha256, shared, undefined, concat(utf8('p2ptalk-pair-v3 inbox '), receiverPublicEd), 32);

export function pairKeys(mySecretEd: Uint8Array, myPublicEd: Uint8Array, theirPublicEd: Uint8Array): PairKeys {
  const ss = x25519.getSharedSecret(x25519SecretFromEd(mySecretEd), x25519PublicFromEd(theirPublicEd));
  if (ss.every((b) => b === 0)) throw new Error('bad key');
  const [a, b] = toHex(myPublicEd) < toHex(theirPublicEd) ? [myPublicEd, theirPublicEd] : [theirPublicEd, myPublicEd];
  const shared = hkdf(sha256, ss, concat(a, b), utf8('p2ptalk-pair-v2'), 32);
  return {
    secret: inboxKey(shared, myPublicEd),
    out: inboxKey(shared, theirPublicEd),
    shared,
    id: hkdf(sha256, shared, undefined, utf8('p2ptalk-pair-v2 id'), 16),
  };
}

export const hourOf = (now = Date.now()) => Math.floor(now / HOUR_MS);

/** The relay tag for one hour. */
export type PairDir = 'offer' | 'reply' | 'taken';

export function pairTag(secret: Uint8Array, dir: PairDir, hour = hourOf()): string {
  return toHex(hkdf(sha256, secret, undefined, utf8(`p2ptalk-pair-v2 tag ${dir} ${hour}`), 32));
}

/** Tags to listen on: last hour, this hour and next hour (for clocks that differ a little). */
export const pairTagsAround = (secret: Uint8Array, dir: PairDir, now = Date.now()) =>
  [-1, 0, 1].map((d) => pairTag(secret, dir, hourOf(now) + d));

const legacyLive = (now: number) => now < LEGACY_PAIR_TAGS_UNTIL;

/**
 * Tags to post an offer / reply / "taken" note to the contact on (their inbox; plus, during the
 * transition, the old shared tag for offers and notes, which older versions listen on).
 */
export function pairSendTags(pair: PairKeys, dir: PairDir, now = Date.now()): string[] {
  const tags = [pairTag(pair.out, dir, hourOf(now))];
  if (dir !== 'reply' && pair.legacy !== false && legacyLive(now)) tags.push(pairTag(pair.shared, dir, hourOf(now)));
  return tags;
}

/**
 * Tags to listen on for what the contact sends me (my inbox). During the transition, replies to MY
 * offer are also read on the old shared tags (a short subscription during my own attempt only, when
 * my offer already shows the link). Offers are never read on the shared tags.
 */
export function pairListenTags(pair: PairKeys, dir: PairDir, now = Date.now()): string[] {
  const tags = pairTagsAround(pair.secret, dir, now);
  if (dir === 'reply' && pair.legacy !== false && legacyLive(now)) tags.push(...pairTagsAround(pair.shared, dir, now));
  return tags;
}

async function aesKey(dh: Uint8Array, pair: PairKeys, label: string, a: Uint8Array, b: Uint8Array) {
  if (dh.every((x) => x === 0)) throw new Error('bad key');
  const raw = hkdf(sha256, concat(dh, pair.shared), pair.id, concat(utf8(`p2ptalk-pair-v2 ${label}`), a, b), 32);
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(key: CryptoKey, ad: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return concat(iv, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad as BufferSource }, key, plain as BufferSource)));
}

async function unseal(key: CryptoKey, ad: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < 28) throw new Error('too short');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(0, 12) as BufferSource, additionalData: ad as BufferSource }, key, blob.subarray(12) as BufferSource));
}

/** Offer to a contact: fresh key || nonce || ciphertext. Keep `ephSecret` to open the reply. */
export async function sealPairOffer(pair: PairKeys, theirPublicEd: Uint8Array, plain: Uint8Array) {
  const ephSecret = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephSecret);
  const theirX = x25519PublicFromEd(theirPublicEd);
  const key = await aesKey(x25519.getSharedSecret(ephSecret, theirX), pair, 'offer', ephPub, theirX);
  return { ephSecret, ephPub, blob: concat(ephPub, await seal(key, concat(utf8('offer'), pair.id, ephPub), plain)) };
}

export async function openPairOffer(pair: PairKeys, mySecretEd: Uint8Array, blob: Uint8Array) {
  if (blob.length < 32 + 28) throw new Error('too short');
  const ephPub = blob.slice(0, 32);
  const myX = x25519.getPublicKey(x25519SecretFromEd(mySecretEd));
  const key = await aesKey(x25519.getSharedSecret(x25519SecretFromEd(mySecretEd), ephPub), pair, 'offer', ephPub, myX);
  return { ephPub, plain: await unseal(key, concat(utf8('offer'), pair.id, ephPub), blob.subarray(32)) };
}

/**
 * Two members of a group who may not be contacts (INTEGRATION_FILES_GROUPS.md §3.2): the same
 * construction as pairKeys, bound to the group id, so the tags and locks differ from the contact pair
 * and from the same two people in another group. Each side checks the other is in the group's current
 * signed record before posting or answering.
 */
export function memberPairKeys(mySecretEd: Uint8Array, myPublicEd: Uint8Array, theirPublicEd: Uint8Array, gid: string): PairKeys {
  const ss = x25519.getSharedSecret(x25519SecretFromEd(mySecretEd), x25519PublicFromEd(theirPublicEd));
  if (ss.every((b) => b === 0)) throw new Error('bad key');
  const [a, b] = toHex(myPublicEd) < toHex(theirPublicEd) ? [myPublicEd, theirPublicEd] : [theirPublicEd, myPublicEd];
  const shared = hkdf(sha256, ss, concat(a, b), utf8(`p2ptalk-member-v1 ${gid}`), 32);
  return {
    secret: inboxKey(shared, myPublicEd),
    out: inboxKey(shared, theirPublicEd),
    shared,
    id: hkdf(sha256, shared, undefined, utf8('p2ptalk-member-v1 id'), 16),
    legacy: false,
  };
}

/** Reply to an offer: my fresh key || nonce || ciphertext, locked to the offer's fresh key. */
export async function sealPairReply(pair: PairKeys, offerEphPub: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const ephSecret = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephSecret);
  const key = await aesKey(x25519.getSharedSecret(ephSecret, offerEphPub), pair, 'reply', ephPub, offerEphPub);
  return concat(ephPub, await seal(key, concat(utf8('reply'), pair.id, offerEphPub), plain));
}

export async function openPairReply(pair: PairKeys, offerEphSecret: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < 32 + 28) throw new Error('too short');
  const ephPub = blob.slice(0, 32);
  const offerEphPub = x25519.getPublicKey(offerEphSecret);
  const key = await aesKey(x25519.getSharedSecret(offerEphSecret, ephPub), pair, 'reply', ephPub, offerEphPub);
  return unseal(key, concat(utf8('reply'), pair.id, offerEphPub), blob.subarray(32));
}

// ---- notes for every device of both people ("taken") ---------------------------------------------

async function noteKey(pair: PairKeys): Promise<CryptoKey> {
  const raw = hkdf(sha256, pair.shared, pair.id, utf8('p2ptalk-pair-v2 note'), 32);
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** A short locked note any device holding either identity key can open: nonce || ciphertext. */
export async function sealPairNote(pair: PairKeys, plain: Uint8Array): Promise<Uint8Array> {
  return seal(await noteKey(pair), concat(utf8('note'), pair.id), plain);
}

export async function openPairNote(pair: PairKeys, blob: Uint8Array): Promise<Uint8Array> {
  return unseal(await noteKey(pair), concat(utf8('note'), pair.id), blob);
}
