import { describe, expect, it } from 'vitest';
import { encode } from 'uqr';
import jsQR from 'jsqr';

// The QR we draw must be readable by the jsQR fallback scanner, even for a long (~1.3 KB) code.
describe('QR round trip', () => {
  it('a long connection code survives QR encode -> jsQR decode', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const text = 'P2P1.' + Array.from({ length: 1300 }, (_, i) => alphabet[(i * 37 + 11) % 64]).join('');
    const qr = encode(text, { ecc: 'L', border: 2 });
    const scale = 4;
    const w = qr.size * scale;
    const px = new Uint8ClampedArray(w * w * 4);
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++) {
        const v = qr.data[Math.floor(y / scale)][Math.floor(x / scale)] ? 0 : 255;
        px.set([v, v, v, 255], (y * w + x) * 4);
      }
    const hit = jsQR(px, w, w);
    expect(hit?.data).toBe(text);
    expect(qr.version).toBeLessThanOrEqual(30);
  });
});
