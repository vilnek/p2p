// Profile and group pictures over the locked chat channel (PROTOCOL.md §21). Never through relays.
//
//   {k:'pic', h}               "my picture is h" (64 hex), or h = '' for "no picture / not for you".
//                              Sent when a connection opens and when my picture or its visibility changes.
//   {k:'pic-get', h, g?}       "send me picture h" (g: the group's picture, from a member of that group).
//   {k:'pic-data', h, g?, t, i, n, d}
//                              piece i of n (d: base64url, ≤ 24 KB each), only in reply to pic-get.
// A side only accepts pieces of a picture it asked for, at most PHOTO_MAX bytes in all, whose SHA-256
// is the hash it asked for, of an allowed type (core/photo.ts). The screens then decode and re-draw it.

import { fromB64url, toB64url } from '../core/bytes';
import { isHash, photoHash, photoProblem, pieces, PHOTO_MAX, PIECE, type PhotoType, type StoredPhoto } from '../core/photo';

export const PIC_FEATURE = 'pic1';
export const PIC_KINDS = new Set(['pic', 'pic-get', 'pic-data']);

type PicFrame =
  | { k: 'pic'; h: string }
  | { k: 'pic-get'; h: string; g?: string }
  | { k: 'pic-data'; h: string; g?: string; t: string; i: number; n: number; d: string };

export interface PhotoHost {
  /** My picture, if this contact may see it (Privacy › Who can see my photo), else null. */
  mine(): StoredPhoto | null;
  /** The picture I keep for a contact (their P2P ID) or a group ("g:<id>"). */
  stored(key: string): StoredPhoto | undefined;
  /** Is this peer a member of that group (so it may ask for, or send, the group's picture)? */
  isMember(gid: string, peerId: string): boolean;
  /** A checked picture arrived (key: their P2P ID, or "g:<id>"), or theirs was removed (null). */
  received(key: string, photo: StoredPhoto | null): void;
}

const MAX_PIECES = Math.ceil(PHOTO_MAX / PIECE);

/** One connection's picture exchange. */
export class PhotoLink {
  private asked = new Map<string, { parts: Uint8Array[]; got: number; n: number; t: string; at: number }>();

  constructor(
    readonly peerId: string,
    private send: (f: PicFrame) => Promise<void>,
    private host: PhotoHost,
  ) {}

  /** Tell them my picture's hash ('' = none, or they may not see it). */
  announce(): Promise<void> {
    return this.send({ k: 'pic', h: this.host.mine()?.h ?? '' }).catch(() => undefined);
  }

  /** Ask this member for a group's picture (its hash comes from the signed group record). */
  askGroup(gid: string, h: string): void {
    if (!isHash(h) || !this.host.isMember(gid, this.peerId)) return;
    this.ask(`g:${gid}`, h, gid);
  }

  private ask(key: string, h: string, g?: string): void {
    const id = `${key} ${h}`;
    const old = this.asked.get(id);
    if (old && Date.now() - old.at < 30_000) return; // already asked
    this.asked.set(id, { parts: [], got: 0, n: 0, t: '', at: Date.now() });
    void this.send(g ? { k: 'pic-get', h, g } : { k: 'pic-get', h }).catch(() => undefined);
  }

  onFrame(raw: unknown): void {
    const f = raw as PicFrame;
    if (!f || typeof f !== 'object' || typeof f.k !== 'string') return;
    if (f.k === 'pic') {
      if (f.h === '') return this.host.stored(this.peerId) ? this.host.received(this.peerId, null) : undefined;
      if (isHash(f.h) && this.host.stored(this.peerId)?.h !== f.h) this.ask(this.peerId, f.h);
      return;
    }
    if (f.k === 'pic-get') {
      if (!isHash(f.h)) return;
      if (f.g !== undefined) {
        if (typeof f.g !== 'string' || !this.host.isMember(f.g, this.peerId)) return;
        const p = this.host.stored(`g:${f.g}`);
        if (p?.h === f.h) void this.reply(p, f.g);
        return;
      }
      const mine = this.host.mine();
      if (mine?.h === f.h) void this.reply(mine);
      return;
    }
    if (f.k === 'pic-data') this.onData(f);
  }

  private async reply(p: StoredPhoto, g?: string): Promise<void> {
    const list = pieces(p.b);
    for (const [i, d] of list.entries())
      await this.send({ k: 'pic-data', h: p.h, ...(g ? { g } : {}), t: p.t, i, n: list.length, d: toB64url(d) }).catch(() => undefined);
  }

  private onData(f: Extract<PicFrame, { k: 'pic-data' }>): void {
    const key = f.g !== undefined ? `g:${f.g}` : this.peerId;
    const id = `${key} ${f.h}`;
    const a = this.asked.get(id);
    if (!a) return; // never asked for: ignored
    if (!Number.isInteger(f.n) || f.n < 1 || f.n > MAX_PIECES || !Number.isInteger(f.i) || f.i < 0 || f.i >= f.n || typeof f.d !== 'string') return void this.asked.delete(id);
    if (a.n && a.n !== f.n) return void this.asked.delete(id);
    a.n = f.n;
    a.t = String(f.t);
    let d: Uint8Array;
    try {
      d = fromB64url(f.d);
    } catch {
      return void this.asked.delete(id);
    }
    if (d.length > PIECE || a.parts[f.i]) return;
    a.parts[f.i] = d;
    a.got += d.length;
    if (a.got > PHOTO_MAX) return void this.asked.delete(id);
    if (a.parts.filter(Boolean).length < a.n) return;
    this.asked.delete(id);
    const b = new Uint8Array(a.got);
    let o = 0;
    for (const part of a.parts) {
      b.set(part, o);
      o += part.length;
    }
    if (photoHash(b) !== f.h || photoProblem(b, a.t)) return; // not the picture asked for, or not a picture
    this.host.received(key, { h: f.h, t: a.t as PhotoType, b });
  }
}
