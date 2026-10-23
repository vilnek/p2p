// Pictures on screen: choosing and cropping my picture (or a group's), encoding it without metadata,
// and turning a received picture into something safe to show (core/photo.ts has the rules).
//
// Encoding: the chosen image is drawn on a 256×256 canvas and exported again (WebP, or JPEG where the
// browser can't make WebP), so nothing of the original file survives: no EXIF, no GPS, no thumbnails.
// Showing a received picture: its bytes are checked (type, size, magic bytes), decoded with
// createImageBitmap and drawn again on a canvas; only that new image is put in an <img> (blob: URL).

import { safeBlob, safeMime } from '../core/sinks';
import { photoHash, photoProblem, PHOTO_SIZE, PHOTO_TARGET, sniffType, type PhotoType, type StoredPhoto } from '../core/photo';
import { h, sheet } from './dom';

function canvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = PHOTO_SIZE;
  c.height = PHOTO_SIZE;
  return c;
}

const toBlob = (c: HTMLCanvasElement, type: string, q: number) => new Promise<Blob | null>((resolve) => c.toBlob(resolve, type, q));

/** Draws a square part of an image (source pixels) at 256×256 and encodes it, aiming for ~30 KB. */
export async function encodePhoto(src: CanvasImageSource, sx: number, sy: number, size: number): Promise<StoredPhoto> {
  const c = canvas();
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, sx, sy, size, size, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
  let best: Blob | null = null;
  for (const type of ['image/webp', 'image/jpeg']) {
    for (const q of [0.85, 0.75, 0.62, 0.5, 0.38]) {
      const b = await toBlob(c, type, q);
      if (!b || b.type !== type) break; // this browser can't make this type
      best = b;
      if (b.size <= PHOTO_TARGET) break;
    }
    if (best) break;
  }
  if (!best) throw new Error('This device could not make the picture.');
  const b = new Uint8Array(await best.arrayBuffer());
  return { h: photoHash(b), t: (sniffType(b) ?? 'image/jpeg') as PhotoType, b };
}

/**
 * A picture that came from someone else (or from storage): checked, decoded, drawn again. Returns a
 * blob: URL of the re-drawn image, or null if it is not a picture we accept.
 */
export async function photoUrl(p: StoredPhoto): Promise<string | null> {
  if (photoProblem(p.b, p.t)) return null;
  try {
    const bmp = await createImageBitmap(new Blob([p.b as Uint8Array<ArrayBuffer>], { type: p.t }));
    if (bmp.width > 4096 || bmp.height > 4096) return null;
    const c = canvas();
    c.getContext('2d')!.drawImage(bmp, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
    bmp.close();
    const out = await toBlob(c, 'image/png', 1);
    return out ? URL.createObjectURL(out) : null;
  } catch {
    return null;
  }
}

/**
 * The crop: the picked image in a circle; drag to move, pinch (or the slider / mouse wheel) to zoom.
 * Resolves with the encoded picture, or null if the person cancels.
 */
export function cropPhoto(file: Blob, name = 'photo'): Promise<StoredPhoto | null> {
  const type = safeMime(file.type, name);
  if (!/^image\//.test(type)) return Promise.reject(new Error('Choose a photo (not a video or file).'));
  const url = URL.createObjectURL(file.type === type ? file : safeBlob(new Blob([file], { type }), name));
  return new Promise((resolve, reject) => {
    const VIEW = 260;
    const img = h('img', { class: 'crop-img', src: url, alt: '', draggable: 'false' }) as HTMLImageElement;
    const zoom = h('input', { type: 'range', min: '1', max: '4', step: '0.01', value: '1', class: 'crop-zoom', 'aria-label': 'Zoom', 'data-testid': 'crop-zoom' }) as HTMLInputElement;
    const frame = h('div', { class: 'crop', 'data-testid': 'crop', style: `width:${VIEW}px;height:${VIEW}px` }, img, h('div', { class: 'crop-ring', 'aria-hidden': 'true' }));
    let x = 0;
    let y = 0;
    let s = 1;
    let base = 1;
    const clamp = () => {
      const w = img.naturalWidth * base * s;
      const hh = img.naturalHeight * base * s;
      x = Math.max(-(w - VIEW) / 2, Math.min((w - VIEW) / 2, x));
      y = Math.max(-(hh - VIEW) / 2, Math.min((hh - VIEW) / 2, y));
      img.style.width = `${w}px`;
      img.style.height = `${hh}px`;
      img.style.transform = `translate(${x - w / 2 + VIEW / 2}px, ${y - hh / 2 + VIEW / 2}px)`;
    };
    const finish = (v: StoredPhoto | null, e?: Error) => {
      URL.revokeObjectURL(url);
      back.remove();
      if (e) reject(e);
      else resolve(v);
    };
    // Drag with one finger / the mouse; pinch with two.
    const pts = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    frame.addEventListener('pointerdown', (e) => {
      frame.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y) / s;
      }
    });
    frame.addEventListener('pointermove', (e) => {
      const old = pts.get(e.pointerId);
      if (!old) return;
      const now = { x: e.clientX, y: e.clientY };
      pts.set(e.pointerId, now);
      if (pts.size === 1) {
        x += now.x - old.x;
        y += now.y - old.y;
      } else if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        s = Math.max(1, Math.min(4, Math.hypot(a.x - b.x, a.y - b.y) / pinch));
        zoom.value = String(s);
      }
      clamp();
    });
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = 0;
    };
    frame.addEventListener('pointerup', up);
    frame.addEventListener('pointercancel', up);
    frame.addEventListener('wheel', (e) => {
      e.preventDefault();
      s = Math.max(1, Math.min(4, s * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
      zoom.value = String(s);
      clamp();
    }, { passive: false });
    zoom.addEventListener('input', () => {
      s = Number(zoom.value);
      clamp();
    });
    const save = h('button', { class: 'btn pri', 'data-testid': 'crop-save', type: 'button', disabled: true, onclick: async () => {
      (save as HTMLButtonElement).disabled = true;
      const eff = base * s;
      const w = img.naturalWidth * eff;
      const hh = img.naturalHeight * eff;
      const left = VIEW / 2 + x - w / 2;
      const top = VIEW / 2 + y - hh / 2;
      try {
        finish(await encodePhoto(img, -left / eff, -top / eff, VIEW / eff));
      } catch (e) {
        finish(null, e as Error);
      }
    } }, 'Use photo');
    const back = sheet('crop-sheet',
      h('h2', {}, 'Move and zoom'),
      h('div', { class: 'crop-wrap' }, frame),
      h('div', { class: 'crop-zoom-row' }, h('span', { class: 'muted small' }, '−'), zoom, h('span', { class: 'muted small' }, '+')),
      h('p', { class: 'muted small center' }, 'Only the circle is kept, as a small picture without location or camera details.'),
      save,
      h('button', { class: 'btn sec2', 'data-testid': 'crop-cancel', type: 'button', onclick: () => finish(null) }, 'Cancel'));
    // Closing the sheet another way (tap outside, Escape) cancels too.
    new MutationObserver((_, o) => {
      if (!back.isConnected) {
        o.disconnect();
        URL.revokeObjectURL(url);
        resolve(null);
      }
    }).observe(document.body, { childList: true });
    img.decode().then(
      () => {
        base = Math.max(VIEW / img.naturalWidth, VIEW / img.naturalHeight);
        clamp();
        (save as HTMLButtonElement).disabled = false;
      },
      () => finish(null, new Error('This photo could not be opened.')),
    );
  });
}
