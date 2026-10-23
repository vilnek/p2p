// Tiny DOM helpers shared by the screens (no framework). Colours, spacing and radius live in CSS
// variables (style.css :root), so the screens can be re-skinned there.

import { icon, type IconName } from './icons';

export type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>;
export type Child = Node | string | null | undefined | false;

export function h(tag: string, attrs: Attrs = {}, ...kids: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** An icon-only button (aria-label for screen readers) or, with `text`, an icon + text button. */
export function iconBtn(name: IconName, label: string, attrs: Attrs = {}, text?: string, size = 22): HTMLElement {
  return h(
    'button',
    { class: text ? 'btn with-icon' : 'ib', 'aria-label': text ? undefined : label, title: label, type: 'button', ...attrs },
    icon(name, size),
    text && h('span', {}, text),
  );
}

/** A bottom sheet (phones) or centred dialog (wide). Closed by tapping outside, Escape, or its buttons. */
export function sheet(testid: string, ...kids: Child[]): HTMLElement {
  const panel = h('div', { class: 'sheet', 'data-testid': testid, role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'grab', 'aria-hidden': 'true' }), ...kids);
  // The sheet's heading names the dialog for screen readers.
  const title = panel.querySelector('h2');
  if (title) {
    title.id ||= `${testid}-title`;
    panel.setAttribute('aria-labelledby', title.id);
  }
  const back = h('div', { class: 'dim', onclick: (e) => e.target === back && back.remove() }, panel);
  document.body.append(back);
  return back;
}
export const closeSheets = () => document.querySelectorAll('.dim').forEach((s) => s.remove());
if (typeof addEventListener === 'function') addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.dim').forEach((s, i, all) => i === all.length - 1 && s.remove());
});

/** Pictures by ID (a contact's P2P ID, a group id, my own ID): blob: URLs of re-drawn pictures (ui/photo.ts). */
const photos = new Map<string, string>();
export function setAvatarPhoto(id: string, url: string | null): void {
  const old = photos.get(id);
  if (old && old !== url) URL.revokeObjectURL(old);
  if (url) photos.set(id, url);
  else photos.delete(id);
}
export const avatarPhoto = (id: string): string | undefined => photos.get(id);

/** A round avatar: their picture if there is one, else a letter on one of five gradients (chosen from the ID). */
export function avatar(name: string, id: string, size = 44, online?: boolean): HTMLElement {
  let n = 0;
  for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  const el = h('div', { class: `av g${(n % 5) + 1}`, 'aria-hidden': 'true', 'data-av': id }, (name.trim()[0] ?? '#').toUpperCase());
  const pic = photos.get(id);
  if (pic) el.append(h('img', { class: 'avp', src: pic, alt: '', draggable: 'false', 'data-testid': 'avatar-photo' }));
  if (size !== 44) el.style.cssText = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px`;
  if (online !== undefined) el.append(h('span', { class: `dot${online ? ' on' : ''}` }));
  return el;
}

export const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** "9:38" today, "Yesterday", "Mon", or "12 Oct". */
export function shortWhen(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = 24 * 3600_000;
  if (ts >= today.getTime()) return time(ts);
  if (ts >= today.getTime() - day) return 'Yesterday';
  if (ts >= today.getTime() - 6 * day) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** "Today", "Yesterday", "Monday" (this week), "12 Oct" (this year) or "12 Oct 2025". */
export function dayLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = 24 * 3600_000;
  if (ts >= today.getTime()) return 'Today';
  if (ts >= today.getTime() - day) return 'Yesterday';
  if (ts >= today.getTime() - 6 * day) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], d.getFullYear() === today.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

export const when = (ts: number) => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const duration = (ms: number) => `${pad(Math.floor(ms / 60000))}:${pad(Math.floor(ms / 1000) % 60)}`;
