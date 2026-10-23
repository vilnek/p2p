// Security review 2026-10: M-3 (received files never keep an active type), L-4 (file names without
// bidi / control characters, real extension kept) and M-8 (limits on offers, timeouts, disk space).
import { describe, expect, it } from 'vitest';
import { toB64url } from '../../src/core/bytes';
import { FileTransfers, fileExtension, memorySink, safeBlob, safeFileName, safeMime, type FileSink, type FileTransfersOptions, type TransferInfo } from '../../src/net/files';
import { memPair, sleep } from './memlink';

const ID_A = '111111111111111111111111';

const offer = (over: Record<string, unknown> = {}) => ({
  k: 'file-offer' as const,
  v: 1 as const,
  id: toB64url(crypto.getRandomValues(new Uint8Array(9))),
  name: 'a.bin',
  size: 1000,
  mime: 'application/octet-stream',
  chunk: 262144,
  key: toB64url(crypto.getRandomValues(new Uint8Array(32))),
  ts: Date.now(),
  ...over,
});

function receiver(opts: FileTransfersOptions = {}) {
  const pair = memPair(ID_A, 'me');
  const ft = new FileTransfers(ID_A, { stallMs: 40, progressMs: 0, ...opts });
  ft.attach(pair.a);
  const sent: { k: string; id: string; why?: string }[] = [];
  pair.b.onFrame((f) => sent.push(f as { k: string; id: string; why?: string }));
  const offers: TransferInfo[] = [];
  ft.on('offer', (t) => offers.push(t));
  return { ft, sent, offers, done: () => ft.dispose() };
}

describe('received file types (M-3)', () => {
  it('active types become application/octet-stream; preview types stay', () => {
    for (const t of ['text/html', 'TEXT/HTML; charset=utf-8', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/javascript', 'application/javascript', 'multipart/related', '', 'nonsense'])
      expect(safeMime(t)).toBe('application/octet-stream');
    for (const t of ['image/png', 'image/jpeg', 'video/mp4', 'audio/mpeg', 'application/pdf']) expect(safeMime(t)).toBe(t);
    expect(safeMime('', 'photo.JPG')).toBe('image/jpeg');
    expect(safeMime('', 'page.html')).toBe('application/octet-stream');
  });

  it('an offer keeps no active type, also when the name says .svg or .html', async () => {
    const r = receiver();
    r.ft.onFrame(offer({ name: 'x.svg', mime: 'image/svg+xml' }));
    r.ft.onFrame(offer({ name: 'x.html', mime: '' }));
    r.ft.onFrame(offer({ name: 'x.png', mime: 'image/png' }));
    await sleep(10);
    expect(r.offers.map((o) => o.mime)).toEqual(['application/octet-stream', 'application/octet-stream', 'image/png']);
    r.done();
  });

  it('memory sinks and safeBlob never hand out an active type', async () => {
    const s = memorySink(3, 'text/html');
    await s.write(0, new Uint8Array([60, 98, 62]));
    expect((await s.close()).file!.type).toBe('application/octet-stream');
    const b = safeBlob(new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg');
    expect(b.type).toBe('application/octet-stream');
    const img = new Blob([new Uint8Array(4)], { type: 'image/png' });
    expect(safeBlob(img)).toBe(img);
  });
});

describe('file names (L-4)', () => {
  it('drops bidi and other invisible format characters, keeps emoji joiners', () => {
    expect(safeFileName('holiday‮gpj.exe')).toBe('holidaygpj.exe');
    expect(fileExtension('holiday‮gpj.exe')).toBe('exe');
    expect(safeFileName('a⁦b⁩‎‏؜​﻿.txt')).toBe('ab.txt');
    expect(safeFileName('👨‍👩‍👧.png')).toBe('👨‍👩‍👧.png');
    expect(safeFileName('x\u0085y z.txt')).toBe('x_yz.txt');
  });

  it('no trailing dots or spaces, no Windows device names, no folders', () => {
    expect(safeFileName('report.exe. . ')).toBe('report.exe');
    expect(safeFileName('CON.txt')).toBe('_CON.txt');
    expect(safeFileName('nul')).toBe('_nul');
    expect(safeFileName('../../etc/passwd')).toBe('__.._etc_passwd');
    expect(safeFileName('‮')).toBe('file');
  });

  it('a long name keeps its real extension when shortened', () => {
    const s = safeFileName('a'.repeat(300) + '.exe');
    expect(s.length).toBe(200);
    expect(s.endsWith('.exe')).toBe(true);
  });
});

describe('file offers: limits (M-8)', () => {
  it('at most maxOffers wait for Accept; more are refused as busy', async () => {
    const r = receiver({ maxOffers: 2 });
    for (let i = 0; i < 4; i++) r.ft.onFrame(offer());
    await sleep(20);
    expect(r.offers.length).toBe(2);
    expect(r.sent.filter((f) => f.k === 'file-stop' && f.why === 'busy').length).toBe(2);
    r.done();
  });

  it('an offer not accepted in time is dropped and the sender is told', async () => {
    let now = Date.now();
    const r = receiver({ offerTimeoutMs: 1000, now: () => now });
    const o = offer();
    r.ft.onFrame(o);
    await sleep(10);
    expect(r.ft.get(o.id)?.state).toBe('incoming');
    now += 2000;
    await sleep(80); // a tick
    expect(r.ft.get(o.id)).toMatchObject({ state: 'cancelled', error: 'not accepted in time' });
    expect(r.sent).toContainEqual(expect.objectContaining({ k: 'file-stop', id: o.id, why: 'expired' }));
    r.done();
  });

  it('an accepted file that never gets data fails after the idle limit, and its sink is freed', async () => {
    let now = Date.now();
    const r = receiver({ idleTimeoutMs: 1000, now: () => now });
    const o = offer({ size: 600_000 });
    r.ft.onFrame(o);
    await sleep(10);
    let aborted = false;
    const sink: FileSink = { write: async () => undefined, close: async () => ({ where: 'memory' }), abort: async () => void (aborted = true) };
    await r.ft.accept(o.id, sink);
    now += 2000;
    await sleep(80);
    expect(r.ft.get(o.id)).toMatchObject({ state: 'failed' });
    expect(aborted).toBe(true);
    expect(r.sent).toContainEqual(expect.objectContaining({ k: 'file-stop', id: o.id, why: 'idle' }));
    r.done();
  });

  it('auto-accept only with room on the device and within the daily quota; otherwise the person is asked', async () => {
    let auto = 0;
    const autoSink = async (t: TransferInfo) => (auto++, memorySink(t.size, t.mime));
    const full = receiver({ autoSink, freeSpace: async () => 100_000_000, autoAcceptReserve: 99_999_500 });
    full.ft.onFrame(offer({ size: 1000 }));
    await sleep(20);
    expect(auto).toBe(0);
    expect(full.offers.length).toBe(1);
    full.done();

    const quota = receiver({ autoSink, freeSpace: async () => undefined, autoAcceptPerDay: 2500 });
    for (let i = 0; i < 3; i++) quota.ft.onFrame(offer({ size: 1000 }));
    await sleep(30);
    expect(auto).toBe(2);
    expect(quota.offers.length).toBe(1);
    quota.done();
  });
});
