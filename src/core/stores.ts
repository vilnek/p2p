// Where to get P2P Talk: one entry per store, a link or null (design P3, the home page's download stickers).
// A null store still shows its sticker, with "Coming soon", and is not clickable (aria-disabled).
//
// To turn a store on, put its link here:
//   play    → https://play.google.com/store/apps/details?id=com.vilnek.p2p  (when the Play listing is live)
//   iphone, ipad, mac → the App Store link; windows → the Microsoft Store link.
// Web is this page's own address (p2p.vilnek.in on the site).

export type StoreId = 'play' | 'iphone' | 'ipad' | 'mac' | 'windows' | 'web';

/** Store links that are live today. null = "Coming soon". */
export const STORE_LINKS: Record<Exclude<StoreId, 'web'>, string | null> = {
  play: null,
  iphone: null,
  ipad: null,
  mac: null,
  windows: null,
};

/** Download stickers, in the order the home page shows them. */
export const STORES: readonly { id: StoreId; over: string; name: string }[] = [
  { id: 'play', over: 'Get it on', name: 'Google Play' },
  { id: 'iphone', over: 'Download for', name: 'iPhone' },
  { id: 'ipad', over: 'Download for', name: 'iPad' },
  { id: 'mac', over: 'Download for', name: 'Mac' },
  { id: 'windows', over: 'Get it from', name: 'Microsoft Store' },
  { id: 'web', over: 'Open on the', name: 'Web' },
];

/** The web app's address: this page's own origin (null when opened from a file, with no web address). */
export function webLink(loc: { protocol: string; origin: string } = location): string | null {
  return /^https?:$/.test(loc.protocol) && loc.origin && loc.origin !== 'null' ? `${loc.origin}/` : null;
}

/** A store's link, or null for "Coming soon". */
export function storeLink(id: StoreId, links: Record<Exclude<StoreId, 'web'>, string | null> = STORE_LINKS, loc?: { protocol: string; origin: string }): string | null {
  if (id === 'web') return webLink(loc);
  const url = links[id];
  // Only https links ever become a sticker link.
  return url && /^https:\/\//.test(url) ? url : null;
}

/** Inside the phone or computer app (Capacitor): no download stickers, no video. */
export function inNativeApp(): boolean {
  const c = (globalThis as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!c?.isNativePlatform?.();
}

/** Opened from the home screen as an installed web app: the Web sticker is not needed. */
export function inInstalledWebApp(): boolean {
  try {
    if ((globalThis.navigator as unknown as { standalone?: boolean } | undefined)?.standalone === true) return true;
    return typeof matchMedia === 'function' && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches);
  } catch {
    return false;
  }
}
