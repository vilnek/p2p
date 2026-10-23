import { describe, expect, it } from 'vitest';
import { STORE_LINKS, STORES, storeLink, webLink } from '../../src/core/stores';

// The home page's download stickers (design P3): a link per store, or null for "Coming soon".

describe('store stickers', () => {
  it('today: every store is "Coming soon" except the Web (this site)', () => {
    expect(STORE_LINKS).toEqual({ play: null, iphone: null, ipad: null, mac: null, windows: null });
    for (const s of STORES) if (s.id !== 'web') expect(storeLink(s.id)).toBeNull();
    expect(STORES.map((s) => s.id)).toEqual(['play', 'iphone', 'ipad', 'mac', 'windows', 'web']);
  });

  it('Web is the page’s own origin, and nothing when opened from a file', () => {
    expect(webLink({ protocol: 'https:', origin: 'https://p2p.vilnek.in' })).toBe('https://p2p.vilnek.in/');
    expect(webLink({ protocol: 'file:', origin: 'null' })).toBeNull();
    expect(storeLink('web', STORE_LINKS, { protocol: 'https:', origin: 'https://p2p.vilnek.in' })).toBe('https://p2p.vilnek.in/');
  });

  it('a store with a link becomes clickable; only https links count', () => {
    const play = 'https://play.google.com/store/apps/details?id=com.vilnek.p2p';
    expect(storeLink('play', { ...STORE_LINKS, play })).toBe(play);
    expect(storeLink('play', { ...STORE_LINKS, play: 'javascript:alert(1)' })).toBeNull();
    expect(storeLink('play', { ...STORE_LINKS, play: 'http://example.com' })).toBeNull();
  });
});
