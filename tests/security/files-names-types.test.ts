// SECURITY_REVIEW_2026-10.md, findings M-3 and L-4: a received file keeps an active MIME type
// (text/html, image/svg+xml) that the page later puts behind a same-origin blob: URL, and file
// names keep Unicode bidi controls ("photo<RLO>gpj.exe" shows as "photoexe.jpg").
// EXPECTED TO FAIL while the bugs exist.
import { describe, expect, it } from 'vitest';
import { toB64url } from '../../src/core/bytes';
import { FileTransfers, safeFileName, type TransferInfo } from '../../src/net/files';
import { memPair } from '../unit/memlink';

const ACTIVE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript)/i;

describe('files: received names and types are safe to show and open', () => {
  it('an offered text/html file is not kept as text/html', async () => {
    const pair = memPair('them', 'me');
    const ft = new FileTransfers('them');
    ft.attach(pair.a);
    const offers: TransferInfo[] = [];
    ft.on('offer', (t) => offers.push(t));
    const id = toB64url(crypto.getRandomValues(new Uint8Array(9)));
    ft.onFrame({ k: 'file-offer', v: 1, id, name: 'invoice.html', size: 100, mime: 'text/html', chunk: 262144, key: toB64url(crypto.getRandomValues(new Uint8Array(32))), ts: Date.now() });
    await new Promise((r) => setTimeout(r, 10));
    expect(offers.length).toBe(1);
    expect(offers[0].mime).not.toMatch(ACTIVE); // FAILS today: 'text/html'
  });

  it('bidi control characters are removed from file names', () => {
    const shown = safeFileName('holiday‮gpj.exe');
    expect(shown).not.toMatch(/[‎‏‪-‮⁦-⁩]/); // FAILS today
  });
});
