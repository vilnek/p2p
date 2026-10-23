// Show a code as a QR picture, and scan one with the camera.

import { encode } from 'uqr';
import jsQR from 'jsqr';

/** Draws the QR on a canvas (dark squares on white, with a quiet border). */
export function qrCanvas(text: string): HTMLCanvasElement {
  const qr = encode(text, { ecc: 'L', border: 2 });
  const scale = Math.max(3, Math.floor(720 / qr.size));
  const c = document.createElement('canvas');
  c.width = c.height = qr.size * scale;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#0A0E1A';
  qr.data.forEach((row, y) => row.forEach((on, x) => on && g.fillRect(x * scale, y * scale, scale, scale)));
  c.className = 'qr';
  c.setAttribute('role', 'img');
  c.setAttribute('aria-label', 'QR code');
  return c;
}

interface Detector {
  detect(src: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

/**
 * Opens the back camera in `video` and resolves with the first QR text found.
 * Uses the browser's own barcode reader when there is one, otherwise jsQR.
 */
export async function scanQr(video: HTMLVideoElement, signal: AbortSignal): Promise<string> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  const stop = () => stream.getTracks().forEach((t) => t.stop());
  signal.addEventListener('abort', stop);
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();

  let detector: Detector | null = null;
  const BD = (globalThis as unknown as { BarcodeDetector?: new (o: unknown) => Detector }).BarcodeDetector;
  if (BD) {
    try {
      detector = new BD({ formats: ['qr_code'] });
    } catch {
      detector = null;
    }
  }
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d', { willReadFrequently: true })!;

  try {
    while (!signal.aborted) {
      await new Promise((r) => setTimeout(r, 200));
      if (video.readyState < 2) continue;
      if (detector) {
        try {
          const found = await detector.detect(video);
          if (found[0]?.rawValue) return found[0].rawValue;
          continue;
        } catch {
          detector = null; // fall back to jsQR
        }
      }
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) continue;
      const scale = Math.min(1, 960 / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      g.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = g.getImageData(0, 0, canvas.width, canvas.height);
      const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (hit?.data) return hit.data;
    }
    throw new Error('stopped');
  } finally {
    stop();
    video.srcObject = null;
  }
}
