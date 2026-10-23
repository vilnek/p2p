// Host mode (design CN2, 23 Oct 2026): p2p.vilnek.in/?embed=1&ui=1 inside a host app (Vilnek OS on the Mac).
// The page shows P2P Talk's own full screens (Chats · Groups · Calls · Add · Me) AND keeps the embed API
// (window.P2PTalk, the "loaded" event, the WebKit message handler "p2ptalk"). The identity comes only from
// the host (P2PTalk.start({ words, name, deviceName })) and is held in memory: there are no create-account,
// restore, show-words, sign-out or delete-account screens, and the home page never shows.
// Without ui=1, ?embed=1 stays headless exactly as before (embed.ts). The API lives in main.ts (it drives
// the screens' own state); this file is only the switch and the event bus. Docs: docs/HOST_MODE.md.

/** In version().features only when the screens are on (?embed=1&ui=1). */
export const HOST_UI_FEATURE = 'hostui';

export const isHostUi = (q: URLSearchParams = new URLSearchParams(location.search)): boolean => q.get('embed') === '1' && q.get('ui') === '1';

export type HostEventName =
  | 'loaded'
  | 'ready'
  | 'contact'
  | 'request'
  | 'message'
  | 'message-status'
  | 'call'
  | 'stream'
  | 'recording'
  | 'screen'
  | 'invite'
  | 'devices'
  | 'file'
  | 'share'
  | 'group'
  | 'groupMessage'
  | 'groupCall';

type Handler = (data: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

interface WebKitWindow {
  webkit?: { messageHandlers?: { p2ptalk?: { postMessage(m: unknown): void } } };
}

/** To in-page listeners (full data, with MediaStreams) and to the host app (plain data only). */
export function hostEmit(event: HostEventName, data: unknown, forHost: unknown = data): void {
  for (const fn of [...(handlers.get(event) ?? [])]) {
    try {
      fn(data);
    } catch (e) {
      console.warn('P2PTalk listener', e);
    }
  }
  try {
    (window as unknown as WebKitWindow).webkit?.messageHandlers?.p2ptalk?.postMessage({ event, data: forHost });
  } catch {
    /* no host */
  }
}

export function hostOn(event: HostEventName, fn: Handler): () => void {
  let set = handlers.get(event);
  if (!set) handlers.set(event, (set = new Set()));
  set.add(fn);
  return () => hostOff(event, fn);
}

export function hostOff(event: HostEventName, fn: Handler): void {
  handlers.get(event)?.delete(fn);
}

/** For P2PTalk.ui.show(). */
export const HOST_TABS = ['chats', 'groups', 'calls', 'add', 'me'] as const;
export type HostTab = (typeof HOST_TABS)[number];
export const isHostTab = (t: unknown): t is HostTab => typeof t === 'string' && (HOST_TABS as readonly string[]).includes(t);
