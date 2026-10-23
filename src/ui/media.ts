// Photo and video previews in the chat: a small thumbnail in the bubble, and a full view on tap.
// Made on this device from the local file only (never fetched). Security (M-3): a received file is only
// shown through safeBlob / safeMime (core/sinks.ts): images only in an <img> from a blob with an image
// type from the allow-list, videos only in a <video> with a video type from it. Nothing else is opened.

import { safeBlob, safeMime } from '../core/sinks';
import { h, iconBtn } from './dom';
import { icon } from './icons';

/** Image types a browser can draw (allow-listed by safeMime). HEIC is kept but many browsers can't draw it. */
export const isImageType = (mime: string, name?: string) => /^image\//.test(safeMime(mime, name));
export const isVideoType = (mime: string, name?: string) => /^video\//.test(safeMime(mime, name));
export const isMedia = (mime: string, name?: string) => isImageType(mime, name) || isVideoType(mime, name);

const THUMB = 360; // px, longest side
const MAX_IMAGE = 40 * 1024 * 1024; // bigger photos: no thumbnail (decoding needs the whole picture in memory)

function once<T extends Event>(el: EventTarget, ok: string, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    el.addEventListener(ok, (e) => (clearTimeout(t), resolve(e as T)), { once: true });
    el.addEventListener('error', () => (clearTimeout(t), reject(new Error('cannot read'))), { once: true });
  });
}

function draw(src: CanvasImageSource, w: number, hgt: number): Promise<Blob | null> {
  if (!w || !hgt) return Promise.resolve(null);
  const scale = Math.min(1, THUMB / Math.max(w, hgt));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(hgt * scale));
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', 0.78));
}

/** A small JPEG preview of a photo or a video's first frame, or null (other types, or it can't be read). */
export async function makeThumb(file: Blob, mime: string, name: string): Promise<Blob | null> {
  const image = isImageType(mime, name);
  if (!image && !isVideoType(mime, name)) return null;
  if (image && file.size > MAX_IMAGE) return null;
  const safe = safeBlob(file.type === safeMime(mime, name) ? file : new Blob([file], { type: safeMime(mime, name) }), name);
  const url = URL.createObjectURL(safe);
  try {
    if (image) {
      const img = h('img', { src: url, alt: '' }) as HTMLImageElement;
      await img.decode();
      return await draw(img, img.naturalWidth, img.naturalHeight);
    }
    const v = h('video', { muted: true, playsinline: true, preload: 'auto' }) as HTMLVideoElement;
    v.muted = true;
    v.src = url;
    await once(v, 'loadeddata', 6000);
    v.currentTime = Math.min(0.5, (v.duration || 1) / 3);
    await once(v, 'seeked', 4000);
    const out = await draw(v, v.videoWidth, v.videoHeight);
    v.removeAttribute('src');
    v.load();
    return out;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The thumbnail inside a file bubble: a button (tap → full view); a play mark on videos. */
export function thumbView(thumb: Blob, video: boolean, onOpen: () => void): HTMLElement {
  const url = URL.createObjectURL(thumb.type === 'image/jpeg' ? thumb : new Blob([thumb], { type: 'image/jpeg' }));
  const img = h('img', { src: url, alt: '', draggable: 'false' }) as HTMLImageElement;
  return h('button', { class: `thumb${video ? ' vid' : ''}`, type: 'button', 'data-testid': 'file-thumb', 'aria-label': video ? 'Play video' : 'Open photo', onclick: onOpen },
    img, video ? h('span', { class: 'play', 'aria-hidden': 'true' }, icon('play', 26)) : null);
}

/** Full screen view of a photo or video from this device. Closed by ×, Escape, or a tap outside. */
export function openViewer(file: Blob, mime: string, name: string): void {
  const type = safeMime(mime || file.type, name);
  const image = /^image\//.test(type);
  if (!image && !/^video\//.test(type)) return;
  const url = URL.createObjectURL(file.type === type ? file : new Blob([file], { type }));
  const media = image
    ? h('img', { src: url, alt: name, class: 'vmedia' })
    : h('video', { src: url, class: 'vmedia', controls: true, autoplay: true, playsinline: true });
  const close = () => {
    if (media instanceof HTMLVideoElement) media.pause();
    back.remove();
    URL.revokeObjectURL(url);
    removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const back = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': name, 'data-testid': 'viewer', onclick: (e) => e.target === back && close() },
    h('div', { class: 'vtop' }, h('div', { class: 'vname one-line' }, name), iconBtn('close', 'Close', { 'data-testid': 'viewer-close', onclick: close })),
    media);
  addEventListener('keydown', onKey);
  document.body.append(back);
}
