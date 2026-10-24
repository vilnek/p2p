// Checks dist/p2p.html is one self-contained file: no outside scripts, styles or fonts, and no
// addresses except this allow-list:
//   - the 2 public STUN entries (to learn the device's own internet address);
//   - the 5 built-in public relays (one-scan connect only; also in the page's content policy);
//   - local test relays in the content policy (ws://127.0.0.1:*, ws://localhost:*);
//   - the invite-link base (text only, never fetched: the code after "#" never reaches a server);
//   - the SVG namespace name (a fixed label for drawing the line icons, never fetched);
//   - the Terms and Privacy policy pages (links the person opens; never fetched by the app);
//   - the home page (design P3, header and footer P4): YouTube's privacy-enhanced player (frame-src, and
//     the video address, loaded only when Play is pressed) and the links the person opens (GitHub, About,
//     Contact, vilnek.in, the 7 official Vilnek social pages, and the store listings once they are
//     switched on in src/core/stores.ts; never fetched by the app);
//   - hash-wasm's licence comment (/*! hash-wasm (https://www.npmjs.com/package/hash-wasm) … */, text only).
import { readFileSync, statSync } from 'node:fs';

const ALLOWED = new Set([
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
  'wss://nostr.mom',
  'ws://127.0.0.1:*',
  'ws://localhost:*',
  'https://p2p.vilnek.in/#c=',
  'http://www.w3.org/2000/svg',
  'https://p2p.vilnek.in/terms',
  'https://p2p.vilnek.in/privacy',
  'https://p2p.vilnek.in/terms/',
  'https://p2p.vilnek.in/privacy/',
  'https://www.npmjs.com/package/hash-wasm',
  'https://www.youtube-nocookie.com',
  'https://www.youtube-nocookie.com/embed/Sj6hNUUDaIQ?autoplay=1&rel=0',
  'https://github.com/vilnek/p2p',
  'https://vilnek.in/about',
  'https://vilnek.in/contact',
  'https://vilnek.in/',
  // Follow Vilnek (brands/vilnek/social-kit.md)
  'https://facebook.com/vilnek',
  'https://x.com/Vilnek',
  'https://www.instagram.com/vilnek',
  'https://www.youtube.com/@vilneks',
  'https://www.linkedin.com/company/vilnek',
  'https://t.me/vilnek',
  'https://wa.me/message/EZMPWIIQMIARE1',
  // Store listings (in review; written in src/core/stores.ts, ready to switch on)
  'https://play.google.com/store/apps/details?id=com.vilnek.p2p',
  'https://apps.apple.com/app/id6826231704',
  'https://apps.microsoft.com/detail/9NN48FKMNZLB',
]);

const file = new URL('../dist/p2p.html', import.meta.url);
const html = readFileSync(file, 'utf8');
const found = [
  ...new Set(
    (html.match(/\b(?:(?:https?|wss?):\/\/|(?:stuns?|turns?):)[^\s"'`)<>;,]*/g) ?? [])
      // "wss://" alone is the scheme check in code (e.g. r.replace('wss://', '')), not an address
      .filter((u) => !/^(?:https?|wss?):\/\/$/.test(u)),
  ),
];
const external = [...html.matchAll(/<(script|link|img|iframe|source)\b[^>]*\b(src|href)=["']([^"']+)["']/gi)].map((m) => m[3]);
const bad = found.filter((u) => !ALLOWED.has(u));

console.log(`dist/p2p.html: ${statSync(file).size} bytes`);
console.log('Addresses found:', found.join(', ') || '(none)');
console.log('External src/href:', external.length ? external.join(', ') : '(none)');
if (bad.length || external.length) {
  console.error('FAIL: not on the allow-list:', [...bad, ...external].join(', '));
  process.exit(1);
}
console.log('OK: only STUN, the built-in relays, local test relays, the invite-link base, the SVG namespace name, the Terms / Privacy links, the home page video player and its header / footer links.');
