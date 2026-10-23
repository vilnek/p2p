// The built page's content policy (security review M-3, L-1), shared by the build (vite.config.ts),
// the hosted site (site/make-index.mjs) and the phone apps' copy (native/scripts/sync-web.mjs):
//   - script-src: no 'unsafe-inline'; only the exact inlined script(s), by SHA-256 hash, so any other
//     script that ends up in this origin (for example a received .html file opened from a blob: link)
//     does not run;
//   - no local test relays (ws://127.0.0.1:*, ws://localhost:*) in a release build. The local preview
//     server (vite preview, used by the e2e tests) adds them back when it serves the page.
//   - frame-src: only https://www.youtube-nocookie.com (the home page video, loaded only on Play);
//   - style-src keeps 'unsafe-inline': the page uses inline styles and style attributes; styles can't
//     run code.
import { createHash } from 'node:crypto';

const CSP = /(http-equiv="Content-Security-Policy"\s+content=")([^"]+)(")/;
const LOCAL = ['ws://127.0.0.1:*', 'ws://localhost:*'];
/** The one frame the page may show: YouTube's privacy-enhanced player (home page video, on Play only). */
export const FRAME_SRC = 'https://www.youtube-nocookie.com';

/** SHA-256 (base64) of every inline <script> (no src) as the browser hashes it (UTF-8 of its text). */
export function inlineScriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/.test(m[1])) continue;
    out.push(createHash('sha256').update(m[2].replace(/\r\n?/g, '\n'), 'utf8').digest('base64'));
  }
  return out;
}

function policy(html) {
  const m = CSP.exec(html);
  if (!m) throw new Error('no Content-Security-Policy meta tag');
  return m;
}

/** script-src = the inline scripts' hashes; local test relays dropped (unless keepLocalRelays). */
/**
 * `connectSelf`: the phone apps only. connect-src also gets 'self' (capacitor://localhost on iOS,
 * https://localhost on Android), for the page's own range reads of picked files (nativeFiles.ts,
 * fetch(convertFileSrc(path))). Same origin only; the site does not need it.
 */
export function hardenCsp(html, { keepLocalRelays = false, connectSelf = false } = {}) {
  const m = policy(html);
  const hashes = inlineScriptHashes(html);
  if (!hashes.length) throw new Error('no inline script found');
  // 'wasm-unsafe-eval' (kept when the page asks for it): lets the page compile its own bundled
  // WebAssembly (Argon2id for the chat lock, hash-wasm). It does not allow eval() or new scripts.
  const wasm = /script-src [^;]*'wasm-unsafe-eval'/.test(m[2]) ? " 'wasm-unsafe-eval'" : '';
  let csp = m[2].replace(/script-src [^;]+/, `script-src ${hashes.map((h) => `'sha256-${h}'`).join(' ')}${wasm}`);
  if (!keepLocalRelays) for (const r of LOCAL) csp = csp.split(` ${r}`).join('');
  if (connectSelf && !/connect-src [^;]*'self'/.test(csp)) csp = csp.replace(/connect-src /, "connect-src 'self' ");
  csp = csp.replace(/\s{2,}/g, ' ');
  return html.replace(m[0], m[1] + csp + m[3]);
}

/** For the local preview server only: let the page reach local test relays. */
export function withLocalRelays(html) {
  const m = CSP.exec(html);
  if (!m) return html;
  const add = LOCAL.filter((r) => !m[2].includes(r));
  if (!add.length) return html;
  const csp = m[2].replace(/connect-src ([^;]+)/, (_, list) => `connect-src ${list.trim()} ${add.join(' ')}`);
  return html.replace(m[0], m[1] + csp + m[3]);
}

/** Throws unless the page is release-ready: hashed inline scripts only, and no local relays. */
export function checkReleaseCsp(html) {
  const csp = policy(html)[2];
  const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1] ?? '';
  if (scriptSrc.includes("'unsafe-inline'")) throw new Error("script-src still allows 'unsafe-inline'");
  if (scriptSrc.includes("'unsafe-eval'")) throw new Error("script-src allows 'unsafe-eval'");
  for (const h of inlineScriptHashes(html)) if (!scriptSrc.includes(`'sha256-${h}'`)) throw new Error('an inline script is not in script-src (hash changed?)');
  if (/ws:\/\/(127\.0\.0\.1|localhost)/.test(csp)) throw new Error('local test relay address still in the content policy');
  // Frames: only YouTube's privacy-enhanced player (the home page video, loaded when Play is pressed).
  const frameSrc = /frame-src ([^;]+)/.exec(csp)?.[1].trim();
  if (frameSrc !== undefined && frameSrc !== FRAME_SRC) throw new Error(`frame-src allows more than ${FRAME_SRC}: ${frameSrc}`);
  if (/child-src/.test(csp)) throw new Error('child-src is not expected in the content policy');
}
