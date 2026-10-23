// Profile and group pictures (core/photo.ts, net/photos.ts): checks, hash / announce, the exchange.
import { describe, expect, it } from 'vitest';
import { hasMetadata, needFetch, photoHash, photoProblem, PHOTO_MAX, pieces, sniffType, type StoredPhoto } from '../../src/core/photo';
import { PhotoLink, type PhotoHost } from '../../src/net/photos';

const JPEG = (n: number, extra = new Uint8Array(0)) => {
  const b = new Uint8Array(n + extra.length);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  b.set(extra, 4);
  for (let i = 4 + extra.length; i < b.length; i++) b[i] = (i * 31) & 0xff;
  return b;
};
const WEBP = (n: number) => {
  const b = new Uint8Array(n);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  return b;
};
const photo = (b: Uint8Array, t: StoredPhoto['t'] = 'image/jpeg'): StoredPhoto => ({ h: photoHash(b), t, b });

describe('picture checks', () => {
  it('allowed types only, by their real first bytes; at most 64 KB', () => {
    expect(sniffType(JPEG(100))).toBe('image/jpeg');
    expect(sniffType(WEBP(100))).toBe('image/webp');
    expect(photoProblem(JPEG(2000), 'image/jpeg')).toBeNull();
    expect(photoProblem(WEBP(2000), 'image/webp')).toBeNull();
    expect(photoProblem(JPEG(PHOTO_MAX + 1), 'image/jpeg')).toBe('too big');
    expect(photoProblem(JPEG(2000), 'image/svg+xml')).toBe('not an allowed type');
    expect(photoProblem(new TextEncoder().encode('<svg onload=alert(1)>'), 'image/png')).toBe('not what it says it is');
    expect(photoProblem(JPEG(2000), 'image/webp')).toBe('not what it says it is');
    expect(photoProblem(new Uint8Array(0), 'image/jpeg')).toBe('empty');
  });

  it('sees EXIF / GPS metadata (what we send must have none: checked in the e2e on a real encode)', () => {
    const exif = new TextEncoder().encode('\xff\xe1\0\x40Exif\0\0MM\0*GPSLatitude');
    expect(hasMetadata(JPEG(500, exif))).toBe(true);
    expect(hasMetadata(JPEG(500))).toBe(false);
  });

  it('fetch only a new, valid hash; pieces stay small', () => {
    const h = photoHash(JPEG(10));
    expect(needFetch(undefined, h)).toBe(true);
    expect(needFetch(h, h)).toBe(false);
    expect(needFetch(h, 'zz')).toBe(false);
    expect(pieces(new Uint8Array(60_000)).map((p) => p.length)).toEqual([24576, 24576, 10848]);
  });
});

/** Two ends of one connection, in memory. */
function pair(a: Partial<PhotoHost>, b: Partial<PhotoHost>) {
  const got: { side: string; key: string; p: StoredPhoto | null }[] = [];
  const store = { A: {} as Record<string, StoredPhoto>, B: {} as Record<string, StoredPhoto> };
  const host = (side: 'A' | 'B', o: Partial<PhotoHost>): PhotoHost => ({
    mine: () => null,
    stored: (k) => store[side][k],
    isMember: () => false,
    received: (k, p) => {
      got.push({ side, key: k, p });
      if (p) store[side][k] = p;
      else delete store[side][k];
    },
    ...o,
  });
  const sent: { from: string; f: { k: string } }[] = [];
  let A!: PhotoLink;
  let B!: PhotoLink;
  const deliver = (to: () => PhotoLink, from: string) => async (f: object) => {
    sent.push({ from, f: f as { k: string } });
    await Promise.resolve();
    to().onFrame(JSON.parse(JSON.stringify(f)));
  };
  A = new PhotoLink('bbbb', deliver(() => B, 'A'), host('A', a)); // A's link to B
  B = new PhotoLink('aaaa', deliver(() => A, 'B'), host('B', b)); // B's link to A
  return { A, B, got, store, sent };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

describe('picture exchange over the locked link', () => {
  it('announce → ask → bytes; the same hash again is not fetched twice', async () => {
    const mine = photo(JPEG(50_000));
    const { A, got, sent } = pair({ mine: () => mine }, {});
    await A.announce();
    await settle();
    expect(got).toHaveLength(1);
    expect(got[0].key).toBe('aaaa');
    expect(got[0].p!.b).toEqual(mine.b);
    expect(sent.filter((s) => s.f.k === 'pic-data')).toHaveLength(3); // 50 KB in pieces
    await A.announce();
    await settle();
    expect(sent.filter((s) => s.f.k === 'pic-get')).toHaveLength(1);
  });

  it('"Nobody" (or removed): an empty announce removes the stored picture', async () => {
    let mine: StoredPhoto | null = photo(JPEG(3000));
    const { A, got } = pair({ mine: () => mine }, {});
    await A.announce();
    await settle();
    mine = null;
    await A.announce();
    await settle();
    expect(got.map((g) => !!g.p)).toEqual([true, false]);
  });

  it('refuses bytes nobody asked for, a wrong hash, and a non-image', async () => {
    const { B, got } = pair({}, {});
    const fake = JPEG(1000);
    B.onFrame({ k: 'pic-data', h: photoHash(fake), t: 'image/jpeg', i: 0, n: 1, d: Buffer.from(fake).toString('base64url') });
    expect(got).toHaveLength(0);
    // Asked for h, but other bytes come: refused. A text file claiming to be a PNG: refused.
    const svg = new TextEncoder().encode('<svg/>');
    for (const [h, b, t] of [[photoHash(JPEG(9)), fake, 'image/jpeg'], [photoHash(svg), svg, 'image/png']] as const) {
      B.onFrame({ k: 'pic', h });
      await settle();
      B.onFrame({ k: 'pic-data', h, t, i: 0, n: 1, d: Buffer.from(b).toString('base64url') });
    }
    expect(got).toHaveLength(0);
  });

  it('a group picture only between members of that group', async () => {
    const gp = photo(WEBP(4000), 'image/webp');
    const outsider = pair({ stored: (k) => (k === 'g:g1' ? gp : undefined), isMember: () => false }, { isMember: () => true });
    outsider.B.askGroup('g1', gp.h);
    await settle();
    expect(outsider.got).toHaveLength(0); // A doesn't see B as a member: no bytes
    const member = pair({ stored: (k) => (k === 'g:g1' ? gp : undefined), isMember: () => true }, { isMember: () => true });
    member.B.askGroup('g1', gp.h);
    await settle();
    expect(member.got.map((g) => g.key)).toEqual(['g:g1']);
  });
});
