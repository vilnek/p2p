// "Findable by my ID": a small public card on the relays, so someone who has my 24-digit ID can
// send me a request (plan §6, simplified for Phase 0). Turned on when I copy or share my ID; Me ›
// Privacy turns it off.
//
//   tag  = hex(SHA-256("p2ptalk-idcard-v1" ‖ the 24 digits))       (anyone with the ID can find it)
//   card = {v:1, k, n, rb, bid, rr, ts, g}, signed by the identity key:
//          g = Ed25519.sign(identity, utf8(JSON(["p2ptalk-idcard-v1", k, n, rb, bid, rr, ts])))
//   k = identity key, n = "" (no name: the card is public, so it carries only what is needed),
//   rb = request box key (X25519), bid = request box id (16 bytes, hex), rr = my relays, ts = when published.
// A finder keeps only a card whose key gives exactly those 24 digits and whose signature checks.
// The request itself travels exactly like an invite request (locked to rb), and is accepted or
// blocked once.

import { sha256 } from '@noble/hashes/sha256';
import { concat, fromB64url, toB64url, toHex, utf8 } from './bytes';
import { p2pId, sign, verify } from './identity';

export interface IdCard {
  v: 1;
  k: string;
  n: string;
  rb: string;
  bid: string;
  rr: string[];
  ts: number;
  g: string;
}

/** Cards older than this are ignored (the app publishes again on every open and every 12 h). */
export const ID_CARD_MAX_AGE_MS = 48 * 3600_000;

export const idCardTag = (id: string) => toHex(sha256(concat(utf8('p2ptalk-idcard-v1'), utf8(id))));

const cardBytes = (c: Omit<IdCard, 'g' | 'v'>) => utf8(JSON.stringify(['p2ptalk-idcard-v1', c.k, c.n, c.rb, c.bid, c.rr, c.ts]));

export function makeIdCard(identitySecret: Uint8Array, identityPublic: Uint8Array, name: string, boxPub: Uint8Array, boxId: string, relays: string[], ts = Date.now()): IdCard {
  const body = { k: toB64url(identityPublic), n: name.slice(0, 40), rb: toB64url(boxPub), bid: boxId, rr: relays.slice(0, 8), ts };
  return { v: 1, ...body, g: toB64url(sign(identitySecret, cardBytes(body))) };
}

/** Checks a card found for `id`. Returns null if anything is wrong. */
export function checkIdCard(id: string, c: unknown, now = Date.now()): IdCard | null {
  const x = c as IdCard;
  try {
    if (!x || x.v !== 1 || typeof x.k !== 'string' || typeof x.rb !== 'string' || !/^[0-9a-f]{32}$/.test(x.bid) || !Array.isArray(x.rr)) return null;
    // The same limits as makeIdCard(): a short name and at most 8 relay addresses, all strings.
    if (typeof x.n !== 'string' || x.n.length > 40 || x.rr.length > 8 || !x.rr.every((r) => typeof r === 'string' && r.length <= 255)) return null;
    const key = fromB64url(x.k);
    if (key.length !== 32 || fromB64url(x.rb).length !== 32 || p2pId(key) !== id) return null;
    if (typeof x.ts !== 'number' || x.ts > now + 600_000 || now - x.ts > ID_CARD_MAX_AGE_MS) return null;
    return verify(key, cardBytes(x), fromB64url(x.g)) ? x : null;
  } catch {
    return null;
  }
}

/**
 * Finds a P2P ID in whatever was pasted: "3078 4237 …", dashes, line breaks, or a whole message
 * ("My P2P Talk ID: 3078 4237 7926 7266 2122 3596"). Returns the 24 digits, or null.
 */
export function extractId(text: string): string | null {
  const m = text.match(/(?<!\d)(?:\d[\s\-. ]*){24}(?![\s\-. ]*\d)/);
  if (!m) return null;
  return m[0].replace(/\D/g, '');
}

/** The text "Share my ID" sends: plain, no link. */
export const shareIdText = (formattedId: string) => `My P2P Talk ID: ${formattedId}`;
