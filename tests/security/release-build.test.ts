// SECURITY_REVIEW_2026-10.md, findings M-3 and L-1: the built page's content policy allows inline
// scripts (so any HTML that ends up running in this origin, e.g. a received .html file opened from
// its blob: link, runs scripts with access to the keys), and the phone apps' copy still allows
// ws://127.0.0.1 / ws://localhost "relays".
// EXPECTED TO FAIL while the bugs exist. Needs a build: npm run build && (cd native && npm run sync-web)
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const builds = ['dist/p2p.html', 'native/www/index.html', 'site/out/index.html'].filter((f) => existsSync(f));

describe.each(builds)('release build %s', (file) => {
  const html = readFileSync(file, 'utf8');
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';

  it('allows no local test relays', () => {
    expect(csp).not.toMatch(/ws:\/\/(127\.0\.0\.1|localhost)/); // FAILS today for dist/ and the phone copy
  });

  it('frames only YouTube’s privacy-enhanced player (the home page video, loaded on Play)', () => {
    // Builds made before the home page (e.g. an older phone-app copy) have no frame-src: no frames at all.
    const frameSrc = /frame-src ([^;]+)/.exec(csp)?.[1].trim();
    if (frameSrc !== undefined || file === 'dist/p2p.html') expect(frameSrc).toBe('https://www.youtube-nocookie.com');
    expect(csp).not.toMatch(/child-src/);
    expect(csp).toMatch(/default-src 'none'/);
  });

  it("does not allow inline scripts by 'unsafe-inline'", () => {
    const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1] ?? '';
    expect(scriptSrc).not.toContain("'unsafe-inline'"); // FAILS today
  });
});
