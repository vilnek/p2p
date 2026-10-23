// One set of clean line icons for the whole app, drawn as inline SVG (nothing is fetched).
// Style: 24-unit grid, 2-unit stroke, round caps and joins, currentColor.
//   - Most paths are copied from the confirmed design P2 (
//     Feather-style line icons).
//   - The few the design doesn't draw come from Lucide (ISC licence, https://lucide.dev, pinned in
//     package.json); only those imported here end up in the one file.
// The 4-animal emoji code is NOT an icon: it is the identity check ("safety pictures") and stays emoji.

import { BellOff, Bluetooth, Circle, Eraser, House, Inbox, LogOut, MicOff, Radio, Settings, Share, Trash2, TriangleAlert, Volume2, VolumeX, X, type IconNode } from 'lucide';
import type { PathKind } from '../core/path';

const p = (d: string, extra: Record<string, string> = {}): [string, Record<string, string>] => ['path', { d, ...extra }];
const PHONE = 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.9.7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z';

/** Icons from design P2. */
const DESIGN = {
  back: [p('M15 18l-6-6 6-6')],
  phone: [p(PHONE)],
  video: [['rect', { x: '2', y: '6', width: '14', height: '12', rx: '2' }], p('M16 10.5l6-3.5v10l-6-3.5')],
  'video-off': [p('M10.7 6H14a2 2 0 0 1 2 2v3.3l1 1L22 7v10M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2M2 2l20 20')],
  mic: [['rect', { x: '9', y: '2', width: '6', height: '12', rx: '3' }], p('M19 10v1a7 7 0 0 1-14 0v-1M12 18v4')],
  'screen-share': [['rect', { x: '2', y: '3', width: '20', height: '14', rx: '2' }], p('M8 21h8M12 17v4M12 13V7M9 10l3-3 3 3')],
  'switch-camera': [p('M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5')],
  'hang-up': [p(PHONE, { transform: 'rotate(135 12 12)' })],
  send: [p('M22 2L11 13M22 2l-7 20-4-9-9-4z')],
  plus: [p('M12 5v14M5 12h14')],
  info: [['circle', { cx: '12', cy: '12', r: '10' }], p('M12 16v-4M12 8h0')],
  chat: [p('M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z')],
  user: [['circle', { cx: '12', cy: '8', r: '4' }], p('M4 21a8 8 0 0 1 16 0')],
  'user-add': [['circle', { cx: '9', cy: '8', r: '4' }], p('M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6')],
  qr: [
    ['rect', { x: '3', y: '3', width: '7', height: '7', rx: '1' }],
    ['rect', { x: '14', y: '3', width: '7', height: '7', rx: '1' }],
    ['rect', { x: '3', y: '14', width: '7', height: '7', rx: '1' }],
    p('M14 14h3v3M21 14v.01M14 21h7v-4'),
  ],
  scan: [p('M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10')],
  link: [p('M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L12 5.2M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7')],
  hash: [p('M4 9h16M4 15h16M10 3L8 21M16 3l-2 18')],
  key: [['circle', { cx: '7.5', cy: '15.5', r: '4.5' }], p('M10.7 12.3L21 2M17 6l3 3M14 9l2 2')],
  lock: [['rect', { x: '4', y: '11', width: '16', height: '10', rx: '2' }], p('M8 11V7a4 4 0 0 1 8 0v4')],
  wifi: [p('M2 8.8a15 15 0 0 1 20 0M5 12.9a10 10 0 0 1 14 0M8.5 16.4a5 5 0 0 1 7 0M12 20h0')],
  globe: [['circle', { cx: '12', cy: '12', r: '10' }], p('M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20')],
  check: [p('M20 6L9 17l-5-5')],
  shield: [p('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'), p('M9 12l2 2 4-4')],
  mobile: [['rect', { x: '7', y: '2', width: '10', height: '20', rx: '2' }], p('M11 18h2')],
  laptop: [['rect', { x: '4', y: '4', width: '16', height: '11', rx: '1.5' }], p('M2 19h20')],
  block: [['circle', { cx: '12', cy: '12', r: '10' }], p('M5 5l14 14')],
  right: [p('M9 18l6-6-6-6')],
  bell: [p('M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0')],
  eye: [p('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z'), ['circle', { cx: '12', cy: '12', r: '3' }]],
  copy: [['rect', { x: '9', y: '9', width: '13', height: '13', rx: '2' }], p('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1')],
  file: [p('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'), p('M14 2v6h6')],
  'call-in': [p('M16 2v6h6M23 1l-7 7'), p(PHONE)],
  'call-out': [p('M23 7V1h-6M16 8l7-7'), p(PHONE)],
  // Same style, for the send sheet, photo bubbles and the chat lock (Feather-style line icons).
  image: [['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }], ['circle', { cx: '8.5', cy: '8.5', r: '1.5' }], p('M21 15l-5-5L5 21')],
  camera: [p('M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z'), ['circle', { cx: '12', cy: '13', r: '4' }]],
  folder: [p('M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z')],
  play: [p('M7 4.5v15l12.5-7.5z')],
  // Message ticks: waiting · sent · delivered / read.
  clock: [['circle', { cx: '12', cy: '12', r: '9' }], p('M12 7.5V12l3 2')],
  tick: [p('M4 12.5l5 5L20 6.5')],
  ticks: [p('M1.5 12.5l5 5L17 6.5'), p('M11 16.5l1 1L22.5 6.5')],
  users: [p('M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'), ['circle', { cx: '9', cy: '7', r: '4' }], p('M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75')],
  'users-plus': [p('M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'), ['circle', { cx: '8.5', cy: '7', r: '4' }], p('M20 8v6M23 11h-6')],
  unlock: [['rect', { x: '4', y: '11', width: '16', height: '10', rx: '2' }], p('M8 11V7a4 4 0 0 1 7.9-1')],
} satisfies Record<string, IconNode>;

export const ICONS = {
  ...DESIGN,
  'mic-off': MicOff,
  'bell-off': BellOff,
  trash: Trash2,
  eraser: Eraser,
  'log-out': LogOut,
  settings: Settings,
  share: Share,
  speaker: Volume2,
  'speaker-off': VolumeX,
  close: X,
  bluetooth: Bluetooth,
  radio: Radio,
  inbox: Inbox,
  house: House,
  alert: TriangleAlert,
  circle: Circle,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

/** Path kind -> line icon (the plan's §8.8 emoji stay in core/path.ts for text use). */
export const PATH_ICON: Record<PathKind, IconName> = {
  bluetooth: 'bluetooth',
  local: 'wifi',
  'wifi-direct': 'radio',
  internet: 'globe',
  postbox: 'inbox',
  'own-relay': 'house',
  relay: 'alert',
  offline: 'circle',
};

const NS = 'http://www.w3.org/2000/svg';

/** An inline SVG icon. `size` in CSS pixels (22 in headers, 24–26 on call buttons). Hidden from screen readers. */
export function icon(name: IconName, size = 22, cls = ''): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({
    width: String(size),
    height: String(size),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: `icon ${cls}`.trim(),
    'data-icon': name,
  })) svg.setAttribute(k, v);
  for (const [tag, attrs] of ICONS[name] as IconNode) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}
