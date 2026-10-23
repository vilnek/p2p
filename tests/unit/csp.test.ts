// Security review 2026-10, M-3 / L-1: the release page allows only its own inlined script (by hash)
// and no local test relays (scripts/csp.mjs, used by the build, the site and the phone copy).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS build helper
import { checkReleaseCsp, hardenCsp, inlineScriptHashes, withLocalRelays } from '../../scripts/csp.mjs';

const page = (script: string) =>
  `<!doctype html><head><meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src wss://nos.lol ws://127.0.0.1:* ws://localhost:*; base-uri 'none'"
    /><script type="module" crossorigin>${script}</script></head><body><script src="x.js"></script></body>`;
const csp = (html: string) => /content="([^"]+)"/.exec(html)![1];

describe('release content policy (scripts/csp.mjs)', () => {
  it('script-src becomes the SHA-256 of the inline script; local relays go; styles stay', () => {
    const js = 'console.log("hi")\n';
    const out = hardenCsp(page(js));
    const hash = createHash('sha256').update(js).digest('base64');
    expect(inlineScriptHashes(page(js))).toEqual([hash]);
    expect(csp(out)).toContain(`script-src 'sha256-${hash}';`);
    expect(csp(out)).not.toContain("script-src 'unsafe-inline'");
    expect(csp(out)).toContain("style-src 'unsafe-inline'");
    expect(csp(out)).not.toMatch(/ws:\/\/(127\.0\.0\.1|localhost)/);
    expect(csp(out)).toContain('connect-src wss://nos.lol;');
    expect(() => checkReleaseCsp(out)).not.toThrow();
    expect(hardenCsp(out)).toBe(out); // idempotent (the site and phone copy run it again)
  });

  it("keeps 'wasm-unsafe-eval' (bundled Argon2id for the chat lock) and still refuses 'unsafe-eval'", () => {
    const wasmPage = page('a()').replace("script-src 'unsafe-inline';", "script-src 'unsafe-inline' 'wasm-unsafe-eval';");
    const out = hardenCsp(wasmPage);
    expect(csp(out)).toMatch(/script-src 'sha256-[^']+' 'wasm-unsafe-eval';/);
    expect(() => checkReleaseCsp(out)).not.toThrow();
    expect(hardenCsp(out)).toBe(out);
    expect(() => checkReleaseCsp(out.replace("'wasm-unsafe-eval'", "'unsafe-eval'"))).toThrow(/unsafe-eval/);
  });

  it('the check refuses unsafe-inline, a changed script, and local relays', () => {
    expect(() => checkReleaseCsp(page('a()'))).toThrow(/unsafe-inline/);
    const out = hardenCsp(page('a()'));
    expect(() => checkReleaseCsp(out.replace('a()', 'b()'))).toThrow(/hash/);
    expect(() => checkReleaseCsp(withLocalRelays(out))).toThrow(/local test relay/);
  });

  it("the phone copy may also connect to its own origin ('self'), once; the site does not", () => {
    const out = hardenCsp(page('a()'), { connectSelf: true });
    expect(csp(out)).toContain("connect-src 'self' wss://nos.lol;");
    expect(hardenCsp(out, { connectSelf: true })).toBe(out);
    expect(csp(hardenCsp(page('a()')))).not.toContain("'self'");
    expect(() => checkReleaseCsp(out)).not.toThrow();
  });

  it('the local preview adds the test relays back (and only once)', () => {
    const out = withLocalRelays(hardenCsp(page('a()')));
    expect(csp(out)).toContain('connect-src wss://nos.lol ws://127.0.0.1:* ws://localhost:*;');
    expect(withLocalRelays(out)).toBe(out);
  });
  it('frame-src: only the YouTube privacy-enhanced player (home page video) passes the release check', () => {
    const withFrame = (src: string) => hardenCsp(page('a()').replace("base-uri 'none'", `frame-src ${src}; base-uri 'none'`));
    expect(() => checkReleaseCsp(withFrame('https://www.youtube-nocookie.com'))).not.toThrow();
    expect(() => checkReleaseCsp(withFrame('https://www.youtube.com'))).toThrow(/frame-src/);
    expect(() => checkReleaseCsp(withFrame('https://www.youtube-nocookie.com https://evil.example'))).toThrow(/frame-src/);
    expect(() => checkReleaseCsp(withFrame('*'))).toThrow(/frame-src/);
  });
});
