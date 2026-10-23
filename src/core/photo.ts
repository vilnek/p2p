// Profile and group pictures: the rules that need no screen (checked by tests/unit/photo.test.ts).
//
// A picture is a 256×256 image, re-drawn through a canvas on the device that chose it (no EXIF, no
// GPS), at most PHOTO_MAX bytes, of type image/webp, image/jpeg or image/png only. It travels only
// directly between connected devices over the locked chat channel (net/photos.ts), never to relays and
// never in the public ID card (security review M-6). A received picture is checked here, then decoded
// with createImageBitmap and drawn again before it is shown (ui/photo.ts): raw received bytes are never
// put on screen.

import { sha256 } from '@noble/hashes/sha2';
import { toHex } from './bytes';

export const PHOTO_SIZE = 256;
/** Accepted when received (bigger is refused). The device that encodes aims for about 30 KB. */
export const PHOTO_MAX = 64 * 1024;
export const PHOTO_TARGET = 30 * 1024;
export const PHOTO_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

export interface StoredPhoto {
  /** SHA-256 of the bytes, hex. */
  h: string;
  /** image/webp | image/jpeg | image/png */
  t: PhotoType;
  b: Uint8Array;
}

export const photoHash = (b: Uint8Array): string => toHex(sha256(b));
export const isHash = (h: unknown): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);

/** The type the bytes really are (by their first bytes), or null. */
export function sniffType(b: Uint8Array): PhotoType | null {
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  return null;
}

/** Why these received bytes can't be a picture, or null when they may be decoded (and re-drawn). */
export function photoProblem(b: Uint8Array, claimed: string): string | null {
  if (!(b instanceof Uint8Array) || !b.length) return 'empty';
  if (b.length > PHOTO_MAX) return 'too big';
  if (!(PHOTO_TYPES as readonly string[]).includes(claimed)) return 'not an allowed type';
  if (sniffType(b) !== claimed) return 'not what it says it is';
  return null;
}

/** Does a picture carry metadata (EXIF / XMP)? Used by tests: what we send never should. */
export function hasMetadata(b: Uint8Array): boolean {
  const text = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 64 * 1024)));
  return /Exif\0\0|EXIF|http:\/\/ns\.adobe\.com\/xap|GPS/.test(text);
}

/** After an announce: do we need their bytes? (none stored, or a different picture) */
export const needFetch = (stored: string | undefined, announced: string): boolean => isHash(announced) && stored !== announced;

/** Splits bytes for the chat channel (each piece well under 64 KB once in base64 JSON). */
export const PIECE = 24 * 1024;
export function pieces(b: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += PIECE) out.push(b.subarray(i, i + PIECE));
  return out.length ? out : [new Uint8Array(0)];
}
