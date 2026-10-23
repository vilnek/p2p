import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromB64url, fromUtf8, toB64url, utf8 } from '../../src/core/bytes';
import {
  cardTextFrom,
  decodeCard,
  DEFAULT_RELAYS,
  INVITE_BASE,
  newCard,
  offerTag,
  openBox,
  openReply,
  replyTag,
  sealReply,
  sealToBox,
} from '../../src/core/card';
import { identityFromPhrase, newPhrase } from '../../src/core/identity';
import { makeEvent, SIGNAL_KIND } from '../../src/net/relay';
import { schnorr } from '@noble/curves/secp256k1';

const me = () => identityFromPhrase(newPhrase());

describe('connect card (QR / invite link)', () => {
  it('round-trips and is at most 200 characters with the built-in relays', async () => {
    const a = await me();
    const { card, text, link } = newCard(a.secretKey, a.publicKey, [...DEFAULT_RELAYS]);
    console.log(`card length: ${text.length} characters; invite link: ${link.length}`);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(link.startsWith(INVITE_BASE)).toBe(true);
    const back = decodeCard(text);
    expect(back.identityKey).toEqual(a.publicKey);
    expect(back.boxKey).toEqual(card.boxKey);
    expect(back.boxId).toEqual(card.boxId);
    expect(back.relays).toEqual([...DEFAULT_RELAYS]);
    expect(back.expires).toBe(card.expires);
    expect(back.expires - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(back.expires - Date.now()).toBeLessThanOrEqual(11 * 60_000);
  });

  it('keeps a subset of relays and custom (test) relay addresses', async () => {
    const a = await me();
    const relays = [DEFAULT_RELAYS[1], DEFAULT_RELAYS[3], 'ws://127.0.0.1:7777'];
    const { text } = newCard(a.secretKey, a.publicKey, relays);
    expect(decodeCard(text).relays).toEqual(relays);
  });

  it('is found in a link, a "#c=" fragment or bare text', async () => {
    const a = await me();
    const { text, link } = newCard(a.secretKey, a.publicKey, [...DEFAULT_RELAYS]);
    expect(cardTextFrom(link)).toBe(text);
    expect(cardTextFrom(`http://127.0.0.1:4317/p2p.html?relays=x#c=${text}`)).toBe(text);
    expect(cardTextFrom(`  ${text}\n`)).toBe(text);
    expect(cardTextFrom('P2P1.abc')).toBeNull();
  });

  it('rejects a tampered card (signature)', async () => {
    const a = await me();
    const { text } = newCard(a.secretKey, a.publicKey, [...DEFAULT_RELAYS]);
    for (const pos of [1, 5, 40, 70, 84, 100]) {
      const raw = fromB64url(text);
      raw[pos] ^= 0x01;
      expect(() => decodeCard(toB64url(raw)), `byte ${pos}`).toThrow(/Safety check failed|different version/);
    }
    // someone else's signature on Alice's key
    const m = await me();
    const forged = fromB64url(newCard(m.secretKey, a.publicKey, [...DEFAULT_RELAYS]).text);
    expect(() => decodeCard(toB64url(forged))).toThrow(/Safety check failed/);
  });

  it('rejects an expired card', async () => {
    const a = await me();
    const { text } = newCard(a.secretKey, a.publicKey, [...DEFAULT_RELAYS], Date.now() - 20 * 60_000);
    expect(() => decodeCard(text)).toThrow(/expired/);
    expect(() => decodeCard(text, Date.now() - 15 * 60_000)).not.toThrow();
  });

  it('page content policy allows exactly the built-in relays', () => {
    const html = readFileSync(new URL('../../p2p.html', import.meta.url), 'utf8');
    const connect = /connect-src ([^;]+);/.exec(html)![1].split(/\s+/);
    expect(connect.filter((c) => c.startsWith('wss://')).sort()).toEqual([...DEFAULT_RELAYS].sort());
    expect(connect.filter((c) => !c.startsWith('wss://'))).toEqual(['ws://127.0.0.1:*', 'ws://localhost:*']);
  });
});

describe('one-time reply box', () => {
  it('offer to the box and reply back (round trip)', async () => {
    const a = await me();
    const { card, boxSecret } = newCard(a.secretKey, a.publicKey, [...DEFAULT_RELAYS]);
    const sealed = await sealToBox(card, utf8('the offer'));
    const opened = await openBox(boxSecret, card.boxId, sealed.blob);
    expect(fromUtf8(opened.plain)).toBe('the offer');
    expect(opened.sealPub).toEqual(sealed.sealPub);
    const reply = await sealReply(boxSecret, card.boxId, opened.sealPub, utf8('the answer'));
    expect(fromUtf8(await openReply(sealed.sealSecret, card, reply))).toBe('the answer');
    expect(offerTag(card.boxId)).toMatch(/^[0-9a-f]{64}$/);
    expect(replyTag(card.boxId)).not.toBe(offerTag(card.boxId));
  });

  it('rejects a tampered offer, a wrong box, and a reply to someone else', async () => {
    const a = await me();
    const one = newCard(a.secretKey, a.publicKey, [...DEFAULT_RELAYS]);
    const two = newCard(a.secretKey, a.publicKey, [...DEFAULT_RELAYS]);
    const sealed = await sealToBox(one.card, utf8('offer'));
    const bad = sealed.blob.slice();
    bad[bad.length - 3] ^= 1;
    await expect(openBox(one.boxSecret, one.card.boxId, bad)).rejects.toThrow();
    await expect(openBox(two.boxSecret, two.card.boxId, sealed.blob)).rejects.toThrow(); // wrong box key
    await expect(openBox(one.boxSecret, two.card.boxId, sealed.blob)).rejects.toThrow(); // wrong box id
    const other = await sealToBox(one.card, utf8('other'));
    const reply = await sealReply(one.boxSecret, one.card.boxId, sealed.sealPub, utf8('answer'));
    await expect(openReply(other.sealSecret, one.card, reply)).rejects.toThrow();
  });
});

describe('Nostr events', () => {
  it('are ephemeral, tagged, with a valid id and signature from a throwaway key', async () => {
    const secret = schnorr.utils.randomPrivateKey();
    const ev = makeEvent(secret, 'ab'.repeat(32), 'locked');
    expect(ev.kind).toBe(SIGNAL_KIND);
    expect(ev.kind >= 20000 && ev.kind < 30000).toBe(true);
    expect(ev.tags).toEqual([['t', 'ab'.repeat(32)]]);
    expect(schnorr.verify(ev.sig, ev.id, ev.pubkey)).toBe(true);
  });
});
