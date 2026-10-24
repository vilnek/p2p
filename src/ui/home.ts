// The home page (design P3, approved by Dr Vijay 23 Oct 2026; header
// and footer redesigned as P4, approved 24 Oct 2026): the first screen for
// a visitor with no account on this device. Top bar · hero with the create-account card · the video ·
// Download · Features · How it works · footer.
//   - Top bar: logo and name, a short menu (Features · How it works · Download · Open source) and the two
//     buttons. On narrow screens the menu folds into a ☰ button that opens a small sheet.
//   - The video loads nothing from YouTube until Play is pressed; then the privacy-enhanced player
//     (youtube-nocookie.com, the only frame-src in the content policy) opens in place of the picture.
//   - Download stickers and the footer's store buttons come from core/stores.ts: a store with no link
//     shows "Coming soon" and is not clickable. Inside the installed apps there are no store buttons and
//     no video.
//   - Footer (iDentist.Live style): link columns, "Get P2P Talk" store buttons, "Follow Vilnek" round
//     social buttons, the GitHub button, then "Made in India (flag) for the world" and the © line.
// The pictures are bundled into the one file (WebP, ~70 KB together); every logo is inline SVG; nothing
// is fetched.

import { inInstalledWebApp, inNativeApp, storeLink, STORES, type StoreId } from '../core/stores';
import { h, type Child } from './dom';
import iconUrl from '../assets/home/icon.webp';
import phoneUrl from '../assets/home/phone.webp';
import thumbUrl from '../assets/home/video-thumb.webp';

/** The P2P Talk video (Unlisted for now). Hindi and English audio tracks, chosen in the player. */
export const VIDEO_ID = 'Sj6hNUUDaIQ';
const VIDEO_EMBED = 'https://www.youtube-nocookie.com/embed/Sj6hNUUDaIQ?autoplay=1&rel=0';

const BLOG: string | null = null; // no blog yet: the link shows "Coming soon"
export const OPEN_SOURCE = 'https://github.com/vilnek/p2p';
const VILNEK = 'https://vilnek.in/';
const ABOUT = 'https://vilnek.in/about';
const CONTACT = 'https://vilnek.in/contact';

/** The official Vilnek pages (brands/vilnek/social-kit.md, same order and links as vilnek.in's footer). */
export const SOCIAL: readonly { id: string; name: string; handle: string; url: string; color: string; d: string }[] = [
  { id: 'facebook', name: 'Facebook', handle: 'vilnek', url: 'https://facebook.com/vilnek', color: '#1877F2', d: 'M14 8h3V4h-3c-2.8 0-4 1.7-4 4.3V10H7v4h3v8h4v-8h3l.5-4H14V8.6c0-.4.3-.6.6-.6z' },
  { id: 'x', name: 'X', handle: '@Vilnek', url: 'https://x.com/Vilnek', color: '#E7E9EA', d: 'M3 3h5.2l4.3 6 5-6h2.4l-6.3 7.5L21 21h-5.2l-4.7-6.5L5.6 21H3.2l6.8-8z' },
  { id: 'instagram', name: 'Instagram', handle: '@vilnek', url: 'https://www.instagram.com/vilnek', color: '#E1306C', d: 'M7.5 2h9A5.5 5.5 0 0 1 22 7.5v9a5.5 5.5 0 0 1-5.5 5.5h-9A5.5 5.5 0 0 1 2 16.5v-9A5.5 5.5 0 0 1 7.5 2zM7.5 4A3.5 3.5 0 0 0 4 7.5v9A3.5 3.5 0 0 0 7.5 20h9a3.5 3.5 0 0 0 3.5-3.5v-9A3.5 3.5 0 0 0 16.5 4zM12 7a5 5 0 1 1 0 10a5 5 0 1 1 0-10zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM17.3 5.5a1.2 1.2 0 1 1 0 2.4a1.2 1.2 0 1 1 0-2.4z' },
  { id: 'youtube', name: 'YouTube', handle: '@vilneks', url: 'https://www.youtube.com/@vilneks', color: '#FF0033', d: 'M21.6 7.2a2.7 2.7 0 0 0-1.9-1.9C18 4.8 12 4.8 12 4.8s-6 0-7.7.5a2.7 2.7 0 0 0-1.9 1.9C2 8.9 2 12 2 12s0 3.1.4 4.8a2.7 2.7 0 0 0 1.9 1.9c1.7.5 7.7.5 7.7.5s6 0 7.7-.5a2.7 2.7 0 0 0 1.9-1.9c.4-1.7.4-4.8.4-4.8s0-3.1-.4-4.8zM10 15.1V8.9l5.2 3.1z' },
  { id: 'linkedin', name: 'LinkedIn', handle: 'company/vilnek', url: 'https://www.linkedin.com/company/vilnek', color: '#0A66C2', d: 'M3 9h4v12H3zM5 2.8a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 1 1 0-4.4zM10 9h3.8v1.8c.6-1.1 2-2.1 4-2.1 3.3 0 4.2 2 4.2 5.2V21h-4v-6.2c0-1.6-.4-2.7-1.9-2.7-1.6 0-2.1 1.2-2.1 2.8V21h-4z' },
  { id: 'telegram', name: 'Telegram', handle: '@vilnek', url: 'https://t.me/vilnek', color: '#26A5E4', d: 'M21.9 4.3l-3.2 15.1c-.2 1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-.9.5l.3-5L18 6.2c.4-.3-.1-.5-.6-.2L6.2 13.1l-4.8-1.5c-1-.3-1-1 .2-1.5L20.5 2.8c.9-.3 1.6.2 1.4 1.5z' },
  { id: 'whatsapp', name: 'WhatsApp', handle: 'Chat with Vilnek', url: 'https://wa.me/message/EZMPWIIQMIARE1', color: '#25D366', d: 'M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zM12 20.2a8.2 8.2 0 0 1-4.2-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zM16.5 14.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.6.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7a2.8 2.8 0 0 0 1.8-1.3 2.3 2.3 0 0 0 .2-1.3c-.1-.1-.3-.2-.5-.3z' },
];

// ---- small inline pictures (no store artwork, no outside files) ----

const NS = 'http://www.w3.org/2000/svg';
type Shape = [string, Record<string, string>];

function svg(shapes: Shape[], attrs: Record<string, string> = {}): SVGSVGElement {
  const el = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', ...attrs })) el.setAttribute(k, v);
  for (const [tag, a] of shapes) {
    const s = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(a)) s.setAttribute(k, v);
    el.append(s);
  }
  return el;
}

const ANDROID = 'M6 9h12v7.5a1.5 1.5 0 0 1-1.5 1.5H15v2.5a1 1 0 0 1-2 0V18h-2v2.5a1 1 0 0 1-2 0V18H7.5A1.5 1.5 0 0 1 6 16.5zM4 9.5a1 1 0 0 1 2 0V14a1 1 0 0 1-2 0zm14 0a1 1 0 0 1 2 0V14a1 1 0 0 1-2 0zM6.2 8a6 6 0 0 1 11.6 0z';
const WINDOWS = 'M3 5.5 10.5 4.5v7H3zm8.5-1.1L21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zm8.5 0H21V21l-9.5-1.4z';
const APPLE = 'M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.8-.9-3-.8-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.1 2.8-2.3.9-1.3 1.3-2.6 1.3-2.6s-2.5-1-2.5-3.8zM14.1 5.8c.6-.8 1.1-1.9 1-3-.9 0-2.1.6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1 .1 2.1-.5 2.7-1.3z';
const GITHUB = 'M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z';
const globe = (color: string) => svg([['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18' }]], { fill: 'none', stroke: color, 'stroke-width': '2' });

const STORE_ICON: Record<StoreId, () => SVGSVGElement> = {
  play: () => svg([['path', { fill: '#3DDC84', d: ANDROID }]]),
  windows: () => svg([['path', { fill: '#3B82F6', d: WINDOWS }]]),
  iphone: () => svg([['path', { fill: '#E8EEF8', d: APPLE }]]),
  ipad: () => svg([['path', { fill: '#A78BFA', d: APPLE }]]),
  mac: () => svg([['path', { fill: '#F472B6', d: APPLE }]]),
  web: () => globe('#4FD1E8'),
};
const downArrow = () => svg([['path', { d: 'M12 4v12M6 11l6 6 6-6M5 20h14' }]], { class: 'hm-dl' });

/** The store logos for the footer's badge buttons (each store's own shape and colours, drawn here). */
const BADGE_ICON = {
  play: () => svg([
    ['path', { fill: '#4285F4', d: 'M3.6 2.2c-.3.3-.5.8-.5 1.4v16.8c0 .6.2 1.1.5 1.4l9.4-9.8z' }],
    ['path', { fill: '#34A853', d: 'M14.2 11.1L5.4 2l11.4 6.4z' }],
    ['path', { fill: '#FBBC04', d: 'M17.9 9.1l3 1.7c.9.5.9 1.8 0 2.3l-3 1.7-2.8-2.8z' }],
    ['path', { fill: '#EA4335', d: 'M14.2 12.9l2.6 2.7L5.4 22z' }],
  ]),
  appstore: () => svg([['path', { fill: '#F5F7FA', d: APPLE }]]),
  microsoft: () => svg([
    ['path', { fill: '#F25022', d: 'M3 3h8.5v8.5H3z' }], ['path', { fill: '#7FBA00', d: 'M12.5 3H21v8.5h-8.5z' }],
    ['path', { fill: '#00A4EF', d: 'M3 12.5h8.5V21H3z' }], ['path', { fill: '#FFB900', d: 'M12.5 12.5H21V21h-8.5z' }],
  ]),
  web: () => globe('#4FD1E8'),
} as const;

/** India's flag, drawn here so it looks the same on every device (no emoji font needed). */
function indiaFlag(): SVGSVGElement {
  let spokes = '';
  for (let i = 0; i < 24; i++) {
    const a = (i * Math.PI) / 12;
    spokes += `M15 10L${(15 + 2.55 * Math.cos(a)).toFixed(2)} ${(10 + 2.55 * Math.sin(a)).toFixed(2)}`;
  }
  return svg([
    ['rect', { width: '30', height: '20', rx: '2', fill: '#FFFFFF' }],
    ['path', { fill: '#FF9933', d: 'M2 0h26a2 2 0 0 1 2 2v4.67H0V2a2 2 0 0 1 2-2z' }],
    ['path', { fill: '#138808', d: 'M0 13.33h30V18a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2z' }],
    ['circle', { cx: '15', cy: '10', r: '2.8', fill: 'none', stroke: '#000080', 'stroke-width': '0.45' }],
    ['path', { d: spokes, stroke: '#000080', 'stroke-width': '0.22' }],
    ['circle', { cx: '15', cy: '10', r: '0.55', fill: '#000080' }],
  ], { viewBox: '0 0 30 20', class: 'hm-flag', 'data-testid': 'india-flag' });
}

const burger = () => svg([['path', { d: 'M4 7h16M4 12h16M4 17h16' }]], { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' });
const cross = () => svg([['path', { d: 'M6 6l12 12M18 6L6 18' }]], { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' });

// ---- pieces ----

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function scrollToEl(el: Element, focus?: HTMLElement): void {
  el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  focus?.focus({ preventScroll: true });
}

const external = { target: '_blank', rel: 'noopener noreferrer' } as const;

/** One store sticker (the Download section): a link when the store is live, else a "Coming soon" sticker that does nothing. */
function sticker(id: StoreId, over: string, name: string): HTMLElement {
  const url = storeLink(id);
  const label = url ? `${over} ${name}` : `${name}: coming soon`;
  const kids: Child[] = [STORE_ICON[id](), h('span', { class: 'hm-lbl' }, h('small', { class: url ? '' : 'hm-soon' }, url ? over : 'Coming soon'), h('b', {}, name)), url ? downArrow() : null];
  const cls = `hm-stk big${url ? '' : ' off'}`;
  const testid = `store-${id}`;
  if (url) return h('a', { class: cls, href: url, 'data-testid': testid, 'aria-label': label, title: label, ...(id !== 'web' ? external : {}) }, ...kids);
  return h('span', { class: cls, role: 'link', 'aria-disabled': 'true', 'data-testid': testid, 'aria-label': label, title: label }, ...kids);
}

function visibleStores(): typeof STORES {
  return inInstalledWebApp() ? STORES.filter((s) => s.id !== 'web') : STORES;
}

/** The footer's store buttons: one per store (the App Store one covers iPhone, iPad and Mac). */
type Badge = { key: keyof typeof BADGE_ICON; store: StoreId; name: string; devices: string };
const BADGES: Badge[] = [
  { key: 'play', store: 'play', name: 'Google Play', devices: 'Android' },
  { key: 'appstore', store: 'iphone', name: 'App Store', devices: 'iPhone · iPad · Mac' },
  { key: 'microsoft', store: 'windows', name: 'Microsoft Store', devices: 'Windows' },
  { key: 'web', store: 'web', name: 'Web', devices: 'Any browser' },
];

function storeBadge(b: Badge): HTMLElement {
  const url = storeLink(b.store);
  const label = url ? `${b.name} (${b.devices})` : `${b.name} (${b.devices}): coming soon`;
  const kids: Child[] = [BADGE_ICON[b.key](),
    h('span', { class: 'hm-badge-t' },
      h('small', {}, url ? null : h('em', {}, 'Coming soon'), url ? b.devices : ` · ${b.devices}`),
      h('b', {}, b.name))];
  const cls = `hm-badge${url ? '' : ' off'}`;
  const testid = `foot-store-${b.key}`;
  if (url) return h('a', { class: cls, href: url, 'data-testid': testid, 'aria-label': label, title: label, ...(b.store !== 'web' ? external : {}) }, ...kids);
  return h('span', { class: cls, role: 'link', 'aria-disabled': 'true', 'data-testid': testid, 'aria-label': label, title: label }, ...kids);
}

/** The video: a picture with a Play button. Only Play loads YouTube's (privacy-enhanced) player. */
function videoBox(): { el: HTMLElement; play: HTMLButtonElement } {
  const frame = h('div', { class: 'hm-frame', 'data-testid': 'home-video-frame' });
  const play = h('button', { class: 'hm-play', type: 'button', 'data-testid': 'home-video-play', 'aria-label': 'Play the video: See P2P Talk in 5 minutes' }, h('span', { class: 'hm-play-dot', 'aria-hidden': 'true' })) as HTMLButtonElement;
  play.addEventListener('click', () => {
    const iframe = h('iframe', {
      src: VIDEO_EMBED,
      title: 'See P2P Talk in 5 minutes (video)',
      'data-testid': 'home-video-iframe',
      allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
      allowfullscreen: true,
      // The page sends no address to anyone (no-referrer); the player needs to know which site it is on.
      referrerpolicy: 'strict-origin-when-cross-origin',
    });
    frame.replaceChildren(iframe);
    iframe.focus();
  });
  frame.append(h('img', { src: thumbUrl, alt: 'P2P Talk video: No server. Just you. Chat, calls, files and screen share, by Vilnek.', width: '960', height: '540' }), play);
  return { el: frame, play };
}

/** A footer link: a page on this page (button), an outside page (new tab), or "Coming soon" (not a link). */
type FootLink = { label: string; testid: string; href?: string | null; onclick?: () => void };
function footLink(l: FootLink): HTMLElement {
  const a = l.onclick
    ? h('button', { class: 'hm-flink', type: 'button', 'data-testid': l.testid, onclick: l.onclick }, l.label)
    : l.href
      ? h('a', { class: 'hm-flink', href: l.href, 'data-testid': l.testid, ...external }, l.label)
      : h('span', { class: 'hm-flink off', role: 'link', 'aria-disabled': 'true', 'aria-label': `${l.label}: coming soon`, 'data-testid': l.testid }, l.label, h('em', { class: 'hm-soon-tag' }, 'Coming soon'));
  return h('li', {}, a);
}

// ---- the page ----

export type HomeOptions = {
  /** The name field (kept as data-testid "name" so the account flow stays the same). */
  name: HTMLInputElement;
  /** "Make my account". */
  onMake: () => void;
  /** "I have 24 words": the restore screen. */
  onRestore: () => void;
  /** The Terms / Privacy line under the card. */
  terms: HTMLElement;
  termsUrl: string;
  privacyUrl: string;
};

export function homePage(o: HomeOptions): HTMLElement {
  const native = inNativeApp();
  o.name.classList.add('hm-input');
  o.name.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && o.onMake());

  const signup = h('section', { class: 'hm-signup hm-glass', id: 'create', 'data-testid': 'home-create-card', 'aria-labelledby': 'hm-create-title' },
    h('h3', { id: 'hm-create-title' }, 'Create your account in 10 seconds'),
    h('p', {}, 'Your account is made on this device. No email, no phone number.'),
    h('div', { class: 'hm-row' }, o.name,
      h('button', { class: 'hm-btn primary', type: 'button', 'data-testid': 'make-account', onclick: o.onMake }, 'Make my account')),
    o.terms);
  const toCreate = () => scrollToEl(signup, o.name);

  const video = native ? null : videoBox();
  const videoSec = video
    ? h('section', { class: 'hm-sec', id: 'video', 'data-testid': 'home-video', 'aria-labelledby': 'hm-video-title' },
        h('h2', { id: 'hm-video-title' }, 'See P2P Talk in 5 minutes'),
        h('p', { class: 'hm-sub' }, 'How it works, every feature, and why nothing passes through our servers.'),
        h('div', { class: 'hm-video hm-glass' }, video.el),
        h('p', { class: 'hm-vlang', 'data-testid': 'home-video-audio' }, 'Audio: ', h('b', { lang: 'hi' }, 'हिन्दी'), ' · English (switch in the player’s ⚙ settings)'))
    : null;
  const toVideo = () => videoSec && video && scrollToEl(videoSec, video.play);

  const stores = native ? [] : visibleStores();
  const downloadSec = stores.length
    ? h('section', { class: 'hm-sec', id: 'download', 'data-testid': 'home-download', 'aria-labelledby': 'hm-dl-title' },
        h('h2', { id: 'hm-dl-title' }, 'Get P2P Talk everywhere'),
        h('p', { class: 'hm-sub' }, 'The same account on all your devices: open it anywhere with your 24 words.'),
        h('div', { class: 'hm-stickgrid' }, ...stores.map((s) => sticker(s.id, s.over, s.name))))
    : null;

  const features: [string, string][] = [
    ['Chats with ticks', 'Online status, read ticks, chat lock with your own code.'],
    ['Voice and video calls', 'One-to-one and group calls, directly between devices.'],
    ['Files of any size', 'Photos, videos and documents in original quality, with live speed.'],
    ['Screen sharing', 'Share your screen and your device sound.'],
    ['Groups', 'Family, friends and teams, locked end to end.'],
    ['Privacy first', 'No ads, no tracking, screenshots blocked in the app, open source.'],
  ];
  const featSec = h('section', { class: 'hm-sec', id: 'features', 'data-testid': 'home-features', 'aria-labelledby': 'hm-feat-title' },
    h('h2', { id: 'hm-feat-title' }, 'Everything you need, nothing you don’t'),
    h('p', { class: 'hm-sub' }, 'Built for families, friends, clinics and teams.'),
    h('div', { class: 'hm-feat' }, ...features.map(([t, d]) => h('div', { class: 'hm-f hm-glass' }, h('h3', {}, t), h('p', {}, d)))));

  const steps: [string, string][] = [
    ['Make your account', 'Enter a name. You get a 24-digit P2P ID and 24 secret words.'],
    ['Add people', 'Scan their QR code, send an invite link, or paste their P2P ID.'],
    ['Talk directly', 'Chats, calls and files go straight from your device to theirs.'],
  ];
  const howSec = h('section', { class: 'hm-sec', id: 'how', 'data-testid': 'home-how', 'aria-labelledby': 'hm-how-title' },
    h('h2', { id: 'hm-how-title' }, 'How it works'),
    h('p', { class: 'hm-sub' }, 'Three steps, no sign-up form.'),
    h('ol', { class: 'hm-how' }, ...steps.map(([t, d], i) => h('li', { class: 'hm-step hm-glass' }, h('div', { class: 'hm-n', 'aria-hidden': 'true' }, String(i + 1)), h('h3', {}, t), h('p', {}, d)))));

  // ---- footer (iDentist.Live style) ----
  const cols: [string, FootLink[]][] = [
    ['P2P Talk', [
      { label: 'Features', testid: 'foot-features', onclick: () => scrollToEl(featSec) },
      { label: 'How it works', testid: 'foot-how', onclick: () => scrollToEl(howSec) },
      ...(videoSec ? [{ label: 'Watch the video', testid: 'foot-video', onclick: toVideo }] : []),
      { label: 'Blog', testid: 'foot-blog', href: BLOG },
    ]],
    ['Vilnek', [
      { label: 'About Vilnek', testid: 'foot-about', href: ABOUT },
      { label: 'Contact us', testid: 'foot-contact', href: CONTACT },
      { label: 'vilnek.in', testid: 'foot-site', href: VILNEK },
    ]],
    ['Legal', [
      { label: 'Privacy policy', testid: 'foot-privacy', href: o.privacyUrl },
      { label: 'Terms of use', testid: 'foot-terms', href: o.termsUrl },
    ]],
  ];
  const badges = native ? [] : BADGES.filter((b) => b.store !== 'web' || !inInstalledWebApp());
  const footer = h('footer', { class: 'hm-foot', 'data-testid': 'home-footer' },
    h('div', { class: 'hm-fcols' },
      h('div', { class: 'hm-fbrand' },
        h('div', { class: 'hm-fbrand-name' }, h('img', { class: 'hm-logo', src: iconUrl, alt: '', width: '34', height: '34' }), h('span', {}, 'P2P Talk'), h('small', {}, 'by Vilnek')),
        h('p', {}, 'Private chats, calls and files, straight from you to them. No server in the middle.'),
        h('a', { class: 'hm-fmail', href: 'mailto:info@vilnek.in', 'data-testid': 'foot-mail' }, 'info@vilnek.in')),
      ...cols.map(([title, links]) => h('nav', { class: 'hm-fcol', 'aria-label': title }, h('h4', {}, title), h('ul', {}, ...links.map(footLink))))),
    badges.length
      ? h('div', { class: 'hm-fblock', 'data-testid': 'foot-stores' }, h('h4', {}, 'Get P2P Talk'), h('div', { class: 'hm-badges' }, ...badges.map(storeBadge)))
      : null,
    h('div', { class: 'hm-frow' },
      h('div', { class: 'hm-fblock', 'data-testid': 'foot-follow' }, h('h4', {}, 'Follow Vilnek'),
        h('nav', { class: 'hm-social', 'aria-label': 'Vilnek on social media' }, ...SOCIAL.map((s) =>
          h('a', { class: 'hm-soc', href: s.url, ...external, style: `--bc:${s.color}`, 'data-testid': `foot-social-${s.id}`, 'aria-label': `Vilnek on ${s.name} (${s.handle})`, title: `${s.name} · ${s.handle}` },
            svg([['path', { fill: 'currentColor', 'fill-rule': 'evenodd', d: s.d }]]))))),
      h('div', { class: 'hm-fblock', 'data-testid': 'foot-opensource' }, h('h4', {}, 'Open source'),
        h('a', { class: 'hm-gh', href: OPEN_SOURCE, ...external, 'data-testid': 'foot-github', 'aria-label': 'P2P Talk’s code on GitHub (vilnek/p2p)' },
          svg([['path', { fill: 'currentColor', d: GITHUB }]]),
          h('span', { class: 'hm-badge-t' }, h('small', {}, 'View the code on'), h('b', {}, 'GitHub')),
          h('span', { class: 'hm-gh-repo' }, 'vilnek/p2p')))),
    h('div', { class: 'hm-fbottom' },
      h('p', { class: 'hm-made', 'data-testid': 'foot-made-in' }, h('span', {}, 'Made in India'), indiaFlag(), h('span', {}, 'for the world')),
      h('p', { class: 'hm-copy', 'data-testid': 'foot-copy' }, '© 2026 VILNEK PRIVATE LIMITED')));

  // ---- top bar: menu on wide screens, ☰ and a small sheet on narrow ones ----
  type MenuItem = { label: string; key: string; go?: () => void; href?: string };
  const menu: MenuItem[] = [
    { label: 'Features', key: 'features', go: () => scrollToEl(featSec) },
    { label: 'How it works', key: 'how', go: () => scrollToEl(howSec) },
    ...(downloadSec ? [{ label: 'Download', key: 'download', go: () => scrollToEl(downloadSec) }] : []),
    { label: 'Open source', key: 'source', href: OPEN_SOURCE },
  ];
  let closeSheet = (_focusButton?: boolean) => {};
  const menuLinks = (where: 'nav' | 'sheet') => menu.map((m) => {
    const cls = where === 'nav' ? 'hm-nav-i' : 'hm-sheet-i';
    const testid = `home-${where}-${m.key}`;
    if (m.href) return h('a', { class: cls, href: m.href, ...external, 'data-testid': testid, onclick: () => closeSheet() }, m.key === 'source' ? svg([['path', { fill: 'currentColor', d: GITHUB }]], { class: 'hm-nav-gh' }) : null, m.label);
    return h('button', { class: cls, type: 'button', 'data-testid': testid, onclick: () => { closeSheet(); m.go!(); } }, m.label);
  });

  const menuBtn = h('button', { class: 'hm-burger', type: 'button', 'data-testid': 'home-menu', 'aria-label': 'Menu', 'aria-expanded': 'false', 'aria-controls': 'hm-menu-sheet' }, burger());
  const sheetEl = h('div', { class: 'hm-msheet hm-glass', id: 'hm-menu-sheet', 'data-testid': 'home-menu-sheet', hidden: true },
    h('nav', { class: 'hm-sheet-nav', 'aria-label': 'Menu' }, ...menuLinks('sheet')),
    h('button', { class: 'hm-btn ghost hm-sheet-restore', type: 'button', 'data-testid': 'home-menu-restore', onclick: () => { closeSheet(); o.onRestore(); } }, 'I have 24 words'));
  const openSheet = () => {
    sheetEl.hidden = false;
    menuBtn.setAttribute('aria-expanded', 'true');
    menuBtn.setAttribute('aria-label', 'Close the menu');
    menuBtn.replaceChildren(cross());
    (sheetEl.querySelector('button, a') as HTMLElement | null)?.focus();
  };
  closeSheet = (focusButton = false) => {
    if (sheetEl.hidden) return;
    sheetEl.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.setAttribute('aria-label', 'Menu');
    menuBtn.replaceChildren(burger());
    if (focusButton) menuBtn.focus();
  };
  menuBtn.addEventListener('click', () => (sheetEl.hidden ? openSheet() : closeSheet()));

  const top = h('header', { class: 'hm-top hm-glass', 'data-testid': 'home-top' },
    h('img', { class: 'hm-logo', src: iconUrl, alt: '', width: '34', height: '34' }),
    h('div', { class: 'hm-brand' }, h('span', {}, 'P2P Talk'), h('small', {}, 'by Vilnek')),
    h('nav', { class: 'hm-nav', 'aria-label': 'Main', 'data-testid': 'home-nav' }, ...menuLinks('nav')),
    h('div', { class: 'hm-top-btns' },
      h('button', { class: 'hm-btn ghost', type: 'button', 'data-testid': 'restore', onclick: o.onRestore }, 'I have 24 words'),
      h('button', { class: 'hm-btn primary', type: 'button', 'data-testid': 'home-open', onclick: toCreate }, 'Open P2P Talk')),
    menuBtn,
    sheetEl);

  // The sheet closes with Escape, or a tap anywhere outside the top bar. The listeners go away with the page.
  const onKey = (e: KeyboardEvent) => {
    if (!top.isConnected) return removeEventListener('keydown', onKey);
    if (e.key === 'Escape' && !sheetEl.hidden) closeSheet(true);
  };
  const onDown = (e: PointerEvent) => {
    if (!top.isConnected) return removeEventListener('pointerdown', onDown);
    if (!sheetEl.hidden && !top.contains(e.target as Node)) closeSheet();
  };
  addEventListener('keydown', onKey);
  addEventListener('pointerdown', onDown);

  const hero = h('div', { class: 'hm-hero' },
    h('div', { class: 'hm-hero-text' },
      h('h1', { 'data-testid': 'home-title' }, 'Chat, call and share', h('br'), h('em', {}, 'straight from you to them.')),
      h('p', { class: 'hm-lead' }, 'Private chats, voice and video calls, original-quality files and screen sharing, device to device. No server in the middle, no phone number, nothing collected.'),
      h('div', { class: 'hm-cta' },
        h('button', { class: 'hm-btn primary', type: 'button', 'data-testid': 'home-create', onclick: toCreate }, 'Create my account, free'),
        videoSec ? h('button', { class: 'hm-btn ghost', type: 'button', 'data-testid': 'home-watch', onclick: toVideo }, '▶ Watch the video') : null),
      h('ul', { class: 'hm-chips', 'aria-label': 'Why P2P Talk' }, ...['No server in the middle', 'No number needed', 'End-to-end locked', 'Open source'].map((t) => h('li', { class: 'hm-chip' }, t))),
      signup),
    h('div', { class: 'hm-phone hm-glass' }, h('img', { src: phoneUrl, alt: 'P2P Talk on a phone: a chat with Ravi Kumar, with a photo and a video sent in original quality.', width: '280', height: '607' })));

  return h('div', { class: `home${native ? ' in-app' : ''}`, 'data-testid': 'home' },
    top,
    h('div', { class: 'hm-wrap' }, hero, videoSec, downloadSec, featSec, howSec, footer));
}
