// Copies the built one-file web app (../dist/p2p.html) into www/index.html for Capacitor.
// Build the web app first: (cd .. && npm run build)
// The copy gets the release content policy (security review M-3 / L-1): the inlined script allowed by its
// SHA-256 only, and no local test relays (../scripts/csp.mjs). Refuses to write a page that fails it.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReleaseCsp, hardenCsp } from '../../scripts/csp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, '../dist/p2p.html');
const outDir = join(root, 'www');
const out = join(outDir, 'index.html');

if (!existsSync(src)) {
  console.error(`Missing ${src}\nBuild the web app first: (cd .. && npm run build)`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const html = hardenCsp(readFileSync(src, 'utf8'), { connectSelf: true }); // 'self': picked-file range reads (I-6)
checkReleaseCsp(html);
writeFileSync(out, html);
console.log(`Copied ${src} -> ${out} (${statSync(out).size} bytes)`);
