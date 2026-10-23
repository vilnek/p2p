// The home page (design P3, approved by Dr Vijay 23 Oct 2026):
// the first screen for a visitor with no account on this device. Top bar · hero with the create-account
// card · the video · Download · Features · How it works · chip footer.
//   - The video loads nothing from YouTube until Play is pressed; then the privacy-enhanced player
//     (youtube-nocookie.com, the only frame-src in the content policy) opens in place of the picture.
//   - Download stickers come from core/stores.ts: a store with no link shows "Coming soon" and is not
//     clickable. Inside the installed apps there are no stickers and no video.
// The pictures are bundled into the one file (WebP, ~70 KB together); nothing is fetched.

import { inInstalledWebApp, inNativeApp, storeLink, STORES, type StoreId } from '../core/stores';
import { h, type Child } from './dom';
import iconUrl from '../assets/home/icon.webp';
import phoneUrl from '../assets/home/phone.webp';
import thumbUrl from '../assets/home/video-thumb.webp';

/** The P2P Talk video (Unlisted for now). Hindi and English audio tracks, chosen in the player. */
export const VIDEO_ID = 'Sj6hNUUDaIQ';
const VIDEO_EMBED = 'https://www.youtube-nocookie.com/embed/Sj6hNUUDaIQ?autoplay=1&rel=0';

const BLOG: string | null = null; // no blog yet: the chip shows "Coming soon"
const OPEN_SOURCE = 'https://github.com/vilnek/p2p';
const ABOUT = 'https://vilnek.in/about';
const CONTACT = 'https://vilnek.in/contact';
const YOUTUBE = 'https://www.youtube.com/@vilneks';

// ---- small inline pictures (platform shapes as iDentist.Live's download links; no store artwork) ----

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
const PLAY = 'M9 7.5v9l7.5-4.5z';

const STORE_ICON: Record<StoreId, () => SVGSVGElement> = {
  play: () => svg([['path', { fill: '#3DDC84', d: ANDROID }]]),
  windows: () => svg([['path', { fill: '#3B82F6', d: WINDOWS }]]),
  iphone: () => svg([['path', { fill: '#E8EEF8', d: APPLE }]]),
  ipad: () => svg([['path', { fill: '#A78BFA', d: APPLE }]]),
  mac: () => svg([['path', { fill: '#F472B6', d: APPLE }]]),
  web: () => svg([['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18' }]], { fill: 'none', stroke: '#4FD1E8', 'stroke-width': '2' }),
};
const TOP_ORDER: StoreId[] = ['play', 'windows', 'iphone', 'ipad', 'mac'];
const downArrow = () => svg([['path', { d: 'M12 4v12M6 11l6 6 6-6M5 20h14' }]], { class: 'hm-dl' });
const lineIcon = (d: string) => svg([['path', { d }]]);

// ---- pieces ----

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function scrollToEl(el: Element, focus?: HTMLElement): void {
  el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  focus?.focus({ preventScroll: true });
}

/** One store sticker: a link when the store is live, else a "Coming soon" sticker that does nothing. */
function sticker(id: StoreId, over: string, name: string, big: boolean): HTMLElement {
  const url = storeLink(id);
  const label = url ? `${over} ${name}` : `${name}: coming soon`;
  const kids: Child[] = big
    ? [STORE_ICON[id](), h('span', { class: 'hm-lbl' }, h('small', { class: url ? '' : 'hm-soon' }, url ? over : 'Coming soon'), h('b', {}, name)), url ? downArrow() : null]
    : [STORE_ICON[id](), url ? downArrow() : h('span', { class: 'hm-soon-dot', 'aria-hidden': 'true' })];
  const cls = `hm-stk${big ? ' big' : ''}${url ? '' : ' off'}`;
  const testid = `${big ? 'store' : 'store-mini'}-${id}`;
  if (url) {
    const external = id !== 'web';
    return h('a', { class: cls, href: url, 'data-testid': testid, 'aria-label': label, title: label, ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}) }, ...kids);
  }
  return h('span', { class: cls, role: 'link', 'aria-disabled': 'true', 'data-testid': testid, 'aria-label': label, title: label }, ...kids);
}

function visibleStores(): typeof STORES {
  return inInstalledWebApp() ? STORES.filter((s) => s.id !== 'web') : STORES;
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

type FootChip = { label: string; color: string; d: string; href?: string | null; onclick?: () => void; testid: string };

function footChip(c: FootChip): HTMLElement {
  const kids = [lineIcon(c.d), c.label];
  const cls = `hm-fchip ${c.color}`;
  if (c.onclick) return h('button', { class: cls, type: 'button', 'data-testid': c.testid, onclick: c.onclick }, ...kids);
  if (c.href) return h('a', { class: cls, href: c.href, target: '_blank', rel: 'noopener noreferrer', 'data-testid': c.testid }, ...kids);
  return h('span', { class: `${cls} off`, role: 'link', 'aria-disabled': 'true', title: `${c.label}: coming soon`, 'aria-label': `${c.label}: coming soon`, 'data-testid': c.testid }, ...kids);
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
        h('div', { class: 'hm-stickgrid' }, ...stores.map((s) => sticker(s.id, s.over, s.name, true))))
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

  const chips: FootChip[] = [
    { label: 'Blog', color: 'c-green', d: 'M4 5h16v14H4zM8 9h8M8 13h5', href: BLOG, testid: 'foot-blog' },
    { label: 'Features', color: 'c-blue', d: 'M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.6 7.1 18.2 8 12.7 4 8.8l5.5-.8z', onclick: () => scrollToEl(featSec), testid: 'foot-features' },
    { label: 'Terms', color: 'c-orange', d: 'M7 3h10v18H7zM10 8h4M10 12h4', href: o.termsUrl, testid: 'foot-terms' },
    { label: 'Privacy', color: 'c-violet', d: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z', href: o.privacyUrl, testid: 'foot-privacy' },
    { label: 'Open source', color: 'c-cyan', d: 'M8 8l-4 4 4 4M16 8l4 4-4 4', href: OPEN_SOURCE, testid: 'foot-source' },
    { label: 'About', color: 'c-blue', d: 'M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', href: ABOUT, testid: 'foot-about' },
    { label: 'Contact', color: 'c-red', d: 'M4 6h16v12H4zM4 7l8 6 8-6', href: CONTACT, testid: 'foot-contact' },
    { label: 'YouTube', color: 'c-violet', d: PLAY, href: YOUTUBE, testid: 'foot-youtube' },
  ];
  const footer = h('footer', { class: 'hm-foot', 'data-testid': 'home-footer' },
    h('nav', { class: 'hm-chipfoot', 'aria-label': 'More about P2P Talk' }, ...chips.map(footChip)),
    h('p', {}, '© 2026 Vilnek Private Limited · Made in India · ', h('a', { href: 'mailto:info@vilnek.in' }, 'info@vilnek.in')));

  const top = h('header', { class: 'hm-top hm-glass', 'data-testid': 'home-top' },
    h('img', { class: 'hm-logo', src: iconUrl, alt: '', width: '34', height: '34' }),
    h('div', { class: 'hm-brand' }, h('span', {}, 'P2P Talk'), h('small', {}, 'by Vilnek')),
    native ? null : h('div', { class: 'hm-stickers', 'data-testid': 'home-top-stickers' },
      // The top bar's order follows the mockup: Android, Windows, iPhone, iPad, Mac.
      ...TOP_ORDER.map((id) => STORES.find((s) => s.id === id)!).map((s) => sticker(s.id, s.over, s.name, false)),
      h('button', { class: 'hm-stk yt', type: 'button', 'data-testid': 'home-top-video', 'aria-label': 'Watch the video', title: 'Watch the video', onclick: toVideo }, svg([['path', { fill: '#C4B5FD', d: PLAY }]]))),
    h('div', { class: 'hm-top-btns' },
      h('button', { class: 'hm-btn ghost', type: 'button', 'data-testid': 'restore', onclick: o.onRestore }, 'I have 24 words'),
      h('button', { class: 'hm-btn primary', type: 'button', 'data-testid': 'home-open', onclick: toCreate }, 'Open P2P Talk')));

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
