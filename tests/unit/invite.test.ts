import { describe, expect, it } from 'vitest';
import { fromB64url, toB64url, utf8 } from '../../src/core/bytes';
import { DEFAULT_RELAYS, decodeCard, INVITE_USED_TEXT, newCard, openBox, sealToBox } from '../../src/core/card';
import { identityFromPhrase, newPhrase, sign } from '../../src/core/identity';
import { verifyRequest, type ContactRequest } from '../../src/net/hub';

const me = () => identityFromPhrase(newPhrase());

describe('invite card (24-hour link)', () => {
  it('round-trips with type, name and 24 h expiry; stays short', async () => {
    const a = await me();
    const { text, link } = newCard(a.secretKey, a.publicKey, [...DEFAULT_RELAYS], Date.now(), { invite: true, name: 'Dr Vijay' });
    console.log(`invite payload: ${text.length} characters; link: ${link.length}`);
    expect(text.length).toBeLessThanOrEqual(215);
    const c = decodeCard(text);
    expect(c.kind).toBe('invite');
    expect(c.name).toBe('Dr Vijay');
    expect(c.expires - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    expect(decodeCard(newCard(a.secretKey, a.publicKey, [...DEFAULT_RELAYS]).text).kind).toBe('scan');
  });

  it('1 hour and 7 days; long names are shortened to 16 bytes', async () => {
    const a = await me();
    const h1 = decodeCard(newCard(a.secretKey, a.publicKey, [...DEFAULT_RELAYS], Date.now(), { invite: true, ttlMs: 3600_000 }).text);
    expect(Math.round((h1.expires - Date.now()) / 60_000)).toBeLessThanOrEqual(61);
    const d7 = decodeCard(newCard(a.secretKey, a.publicKey, [...DEFAULT_RELAYS], Date.now(), { invite: true, ttlMs: 7 * 86400_000, name: 'Dr Vijaykumar Katariya' }).text);
    expect(d7.expires - Date.now()).toBeGreaterThan(6.9 * 86400_000);
    expect(new TextEncoder().encode(d7.name).length).toBeLessThanOrEqual(16);
  });

  it('expired invite gives the plain message; a changed name is rejected', async () => {
    const a = await me();
    const old = newCard(a.secretKey, a.publicKey, [...DEFAULT_RELAYS], Date.now() - 2 * 86400_000, { invite: true, name: 'Ravi' });
    expect(() => decodeCard(old.text)).toThrow(INVITE_USED_TEXT);
    const raw = fromB64url(newCard(a.secretKey, a.publicKey, [...DEFAULT_RELAYS], Date.now(), { invite: true, name: 'Ravi' }).text);
    raw[raw.length - 65] ^= 1; // last byte of the name
    expect(() => decodeCard(toB64url(raw))).toThrow(/Safety check failed/);
  });
});

describe('contact request', () => {
  async function request() {
    const a = await me();
    const b = await me();
    const inv = newCard(a.secretKey, a.publicKey, [...DEFAULT_RELAYS], Date.now(), { invite: true, name: 'A' });
    const inviteId = Buffer.from(inv.card.boxId).toString('hex');
    const body = { k: toB64url(b.publicKey), n: 'Ravi', note: 'hi', rb: toB64url(new Uint8Array(32).fill(7)), rr: [...DEFAULT_RELAYS], ts: 1 };
    const g = toB64url(sign(b.secretKey, utf8(JSON.stringify(['p2ptalk-req-v1', inviteId, body.k, body.n, body.note, body.rb, body.rr, body.ts]))));
    return { inv, inviteId, req: { t: 'req', ...body, g } as ContactRequest };
  }

  it('is signed by the sender and locked to the invite box', async () => {
    const { inv, inviteId, req } = await request();
    expect(verifyRequest(inviteId, req)).toBe(true);
    const sealed = await sealToBox(inv.card, utf8(JSON.stringify(req)));
    const opened = await openBox(inv.boxSecret, inv.card.boxId, sealed.blob);
    expect(JSON.parse(new TextDecoder().decode(opened.plain))).toEqual(req);
  });

  it('rejects a changed name, reply box, or a request for another invite', async () => {
    const { inviteId, req } = await request();
    expect(verifyRequest(inviteId, { ...req, n: 'Mallory' })).toBe(false);
    expect(verifyRequest(inviteId, { ...req, rb: toB64url(new Uint8Array(32).fill(8)) })).toBe(false);
    expect(verifyRequest('00'.repeat(16), req)).toBe(false);
  });

});
