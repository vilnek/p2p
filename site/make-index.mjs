// Turns ../dist/p2p.html into the hosted out/index.html:
// - drops the local test relay addresses from the content policy, and allows only the inlined script by
//   its SHA-256 (no 'unsafe-inline' for scripts; security review M-3 / L-1, ../scripts/csp.mjs),
// - lets the page load its own icons and web-app manifest (installable to the home screen).
import { readFileSync, writeFileSync } from 'node:fs';
import { checkReleaseCsp, hardenCsp } from '../scripts/csp.mjs';
let s = readFileSync('../dist/p2p.html', 'utf8');
const before = s;
s = hardenCsp(s);
s = s.replace("img-src data: blob:;", "img-src 'self' data: blob:; manifest-src 'self';");
s = s.replace('<title>P2P Talk</title>', [
  '<title>P2P Talk</title>',
  '    <link rel="manifest" href="/manifest.webmanifest" />',
  '    <link rel="icon" type="image/png" href="/favicon.png" />',
  '    <link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png" />',
  '    <meta name="theme-color" content="#0A0E1A" />',
  '    <meta name="apple-mobile-web-app-capable" content="yes" />',
  '    <meta name="mobile-web-app-capable" content="yes" />',
  '    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
  '    <meta name="apple-mobile-web-app-title" content="P2P Talk" />',
  '    <meta name="description" content="Open-source chats, calls, files and screen sharing, device to device. No phone number, no server. By Vilnek." />',
].join('\n'));
for (const must of ["manifest-src 'self'", 'rel="manifest"', 'apple-touch-icon']) if (!s.includes(must)) throw new Error('missing: ' + must);
if (s.includes('ws://127.0.0.1')) throw new Error('test relay address still present');
checkReleaseCsp(s);
if (s === before) throw new Error('nothing changed');
writeFileSync('out/index.html', s);
console.log('out/index.html written:', s.length, 'bytes');
