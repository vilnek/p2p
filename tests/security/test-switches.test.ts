// SECURITY_REVIEW_2026-10.md, finding L-1: test switches in the address (?relays=, ?breakIce=,
// ?connectWait=, ?fileDelay=, ?inviteTtl=, ?ring=) must do nothing on the real site, so a crafted
// link can't break someone's connections or point them at other relays.
// Regression guard: failed on the code read at 00:35; src/core/testmode.ts (seen 00:53) fixes it
// in the source. Built files made before that still have the old behaviour.
import { describe, expect, it, vi } from 'vitest';

describe('test switches are ignored on https://p2p.vilnek.in', () => {
  it('a crafted link changes nothing', async () => {
    vi.stubGlobal('location', new URL('https://p2p.vilnek.in/?relays=wss://evil.example&breakIce=1&connectWait=1&fileDelay=99999&inviteTtl=-1&ring=1'));
    vi.resetModules();
    const config = await import('../../src/net/config');
    const peer = await import('../../src/net/peer');
    expect(config.testRelays).toBeNull();
    expect(config.allowedRelays()).not.toContain('wss://evil.example');
    expect(config.testInviteTtl).toBe(0);
    expect(peer.CONNECT_WAIT_MS).toBe(20_000);
    expect(peer.ringTimeoutMs()).toBe(45_000);
    vi.unstubAllGlobals();
  }, 60_000);
});
