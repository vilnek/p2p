import { expect, test, type Browser, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { join } from 'node:path';

// Group calls in real Chrome (fake camera and microphone): one browser context per person, a real
// GroupCallManager and real RTCPeerConnections in each (a full mesh, direct between the pages).
// The test carries the signed signalling frames between the pages, in order per pair, standing in
// for the locked 1:1 chat channels. The page is tests/e2e/gc-harness.ts, bundled here (not part of
// the app build) and served on the test origin by request interception.

const ORIGIN = 'http://127.0.0.1:4318';
const GID = 'G-e2e-seva';
const HTML = `<!doctype html><meta charset="utf-8"><title>Group call test</title>
<button id="share">Share screen</button><div id="tiles"></div><script src="/gc-harness.js"></script>`;
let js = '';

test.beforeAll(async () => {
  const r = await build({ entryPoints: [join(process.cwd(), 'tests/e2e/gc-harness.ts')], bundle: true, write: false, format: 'iife', target: 'es2020', logLevel: 'silent' });
  js = r.outputFiles[0].text;
});

interface PairStats {
  state: string;
  audioIn: number;
  videoIn: number;
  audioOut: number;
  videoOut: number;
  framesDecoded: number;
  frameWidth: number;
  frameHeight: number;
  outFrameWidth: number;
  audioLevel: number;
  rttMs: number;
}
interface Person {
  name: string;
  ctx: BrowserContext;
  page: Page;
  id: string;
  key: string;
}
type Gc = Record<string, (...a: unknown[]) => unknown> & { id: string; key: string };
declare global {
  interface Window {
    gc: Gc;
  }
}

class Room {
  readonly people: Person[] = [];
  private readonly chains = new Map<string, Promise<unknown>>();
  private cdp: CDPSession | null = null;
  constructor(readonly browser: Browser) {}

  async add(name: string): Promise<Person> {
    const ctx = await this.browser.newContext();
    const page = await ctx.newPage();
    await page.route(`${ORIGIN}/gc-harness.html`, (r) => r.fulfill({ contentType: 'text/html', body: HTML }));
    await page.route(`${ORIGIN}/gc-harness.js`, (r) => r.fulfill({ contentType: 'text/javascript', body: js }));
    page.on('pageerror', (e) => console.log(name, 'pageerror', e.message));
    await page.exposeBinding('gcSend', ({ page: src }, to: string, frame: unknown) => this.relay(src, to, frame));
    await page.goto(`${ORIGIN}/gc-harness.html`);
    const { id, key } = await page.evaluate(() => ({ id: window.gc.id, key: window.gc.key }));
    const p = { name, ctx, page, id, key };
    this.people.push(p);
    return p;
  }

  /** One ordered queue per direction, like a data channel. */
  private relay(src: Page, to: string, frame: unknown): void {
    const from = this.people.find((p) => p.page === src);
    const target = this.people.find((p) => p.id === to);
    if (!from || !target) throw new Error('not connected');
    const k = `${from.id}>${to}`;
    const next = (this.chains.get(k) ?? Promise.resolve()).then(() =>
      target.page.evaluate(([f, fr]) => void window.gc.deliver(f, fr), [from.id, frame] as const).catch(() => undefined),
    );
    this.chains.set(k, next);
  }

  async setup(): Promise<void> {
    const rec = { id: GID, name: 'Seva team', members: this.people.map((p) => ({ p2pId: p.id, identityKey: p.key, name: p.name })) };
    for (const p of this.people) await p.page.evaluate(([n, r]) => window.gc.setup(n, r), [p.name, rec] as const);
  }

  async parts(p: Person) {
    return (await p.page.evaluate(() => window.gc.parts())) as { id: string; state: string; reason?: string; hasVideo: boolean; screen: boolean; path?: string }[];
  }

  async connectedAmong(group: Person[]): Promise<boolean> {
    for (const p of group) {
      const ps = await this.parts(p);
      for (const q of group) if (q !== p && ps.find((x) => x.id === q.id)?.state !== 'connected') return false;
    }
    return true;
  }

  async stats(): Promise<Map<Person, Record<string, PairStats>>> {
    const m = new Map<Person, Record<string, PairStats>>();
    await Promise.all(this.people.map(async (p) => m.set(p, (await p.page.evaluate(() => window.gc.stats())) as Record<string, PairStats>)));
    return m;
  }

  /** Chrome's own CPU time (all its processes), in seconds. */
  async cpuTime(): Promise<number> {
    this.cdp ??= await this.browser.newBrowserCDPSession();
    const r = (await this.cdp.send('SystemInfo.getProcessInfo')) as { processInfo: { cpuTime: number }[] };
    return r.processInfo.reduce((s, x) => s + x.cpuTime, 0);
  }

  async close(): Promise<void> {
    for (const p of this.people) await p.ctx.close();
  }
}

/** Every pair among `group`, both ways: bytes in rose. Returns kbit/s per received stream. */
async function measure(room: Room, group: Person[], secs: number, video: boolean) {
  const cpu0 = await room.cpuTime();
  const t0 = Date.now();
  const a = await room.stats();
  await new Promise((r) => setTimeout(r, secs * 1000));
  const b = await room.stats();
  const dt = (Date.now() - t0) / 1000;
  const cpu1 = await room.cpuTime();
  const audio: number[] = [];
  const vid: number[] = [];
  const sizes = new Set<string>();
  for (const p of group) {
    for (const q of group) {
      if (p === q) continue;
      const x = a.get(p)![q.id];
      const y = b.get(p)![q.id];
      expect(x, `${p.name} has a connection to ${q.name}`).toBeTruthy();
      expect(y.audioIn - x.audioIn, `${p.name} hears ${q.name}`).toBeGreaterThan(0);
      audio.push(((y.audioIn - x.audioIn) * 8) / dt / 1000);
      if (video) {
        expect(y.videoIn - x.videoIn, `${p.name} sees ${q.name}`).toBeGreaterThan(0);
        expect(y.framesDecoded - x.framesDecoded, `${p.name} decodes ${q.name}`).toBeGreaterThan(0);
        vid.push(((y.videoIn - x.videoIn) * 8) / dt / 1000);
        sizes.add(`${y.frameWidth}x${y.frameHeight}`);
      }
    }
  }
  const avg = (l: number[]) => (l.length ? Math.round(l.reduce((s, v) => s + v, 0) / l.length) : 0);
  const cores = (cpu1 - cpu0) / dt;
  return {
    pairs: audio.length,
    audioKbps: { avg: avg(audio), min: Math.round(Math.min(...audio)), max: Math.round(Math.max(...audio)) },
    videoKbps: video ? { avg: avg(vid), min: Math.round(Math.min(...vid)), max: Math.round(Math.max(...vid)) } : null,
    frameSizes: [...sizes],
    chromeCpu: { cores: Math.round(cores * 100) / 100, perPersonPercentOfOneCore: Math.round((cores / group.length) * 100) },
  };
}

/** Per pair: ms from "connecting" (both in the call) to "connected" (sound arriving), seen by each side. */
async function connectTimes(room: Room) {
  const pair: number[] = [];
  let frames = 0;
  for (const p of room.people) {
    const tl = (await p.page.evaluate(() => window.gc.timeline())) as { t: number; id: string; state: string }[];
    frames += ((await p.page.evaluate(() => window.gc.frames())) as { sent: number }).sent;
    for (const id of new Set(tl.map((x) => x.id))) {
      const mine = tl.filter((x) => x.id === id);
      const done = mine.findLastIndex((x) => x.state === 'connected');
      const from = mine.slice(0, done).findLastIndex((x) => x.state === 'connecting');
      if (done >= 0 && from >= 0) pair.push(mine[done].t - mine[from].t);
    }
  }
  pair.sort((a, b) => a - b);
  return { pairs: pair.length, medianMs: pair[Math.floor(pair.length / 2)], maxMs: pair[pair.length - 1], signallingFramesPerPerson: Math.round(frames / room.people.length) };
}

async function ring(room: Room, caller: Person, video: boolean, joiners: Person[]): Promise<string> {
  const cid = (await caller.page.evaluate(([g, v]) => window.gc.start(g, v), [GID, video] as const)) as string;
  for (const j of joiners) await expect.poll(async () => (await j.page.evaluate(() => window.gc.invites())) as string[], { timeout: 20_000 }).toContain(cid);
  for (const j of joiners) await j.page.evaluate((c) => window.gc.join(c), cid);
  return cid;
}

async function allConnected(room: Room, group: Person[], timeout = 60_000): Promise<void> {
  try {
    await expect.poll(() => room.connectedAmong(group), { timeout, intervals: [250, 500, 1000] }).toBe(true);
  } catch (e) {
    // What each one sees, for the failure report.
    for (const p of group) {
      const ps = await room.parts(p);
      const tl = (await p.page.evaluate(() => window.gc.timeline())) as { t: number; id: string; state: string }[];
      const names = (id: string) => room.people.find((q) => q.id === id)?.name ?? id;
      console.log(p.name, ps.map((x) => `${names(x.id)}:${x.state}${x.reason ? `(${x.reason})` : ''}`).join(' '), '|', tl.map((x) => `${x.t} ${names(x.id)} ${x.state}`).join(', '));
    }
    throw e;
  }
}

test.describe.configure({ mode: 'serial' });

test('4 people on video: everyone sees and hears everyone; one leaves and rejoins; one shares the screen', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = new Room(browser);
  try {
    const [a, b, c, d] = [await room.add('Asha'), await room.add('Bala'), await room.add('Chitra'), await room.add('Dev')];
    await room.setup();
    const t0 = Date.now();
    const cid = await ring(room, a, true, [b, c, d]);
    await allConnected(room, room.people);
    const setupMs = Date.now() - t0;
    const connect = await connectTimes(room);
    const early = await measure(room, room.people, 4, true);
    await new Promise((r) => setTimeout(r, 10_000)); // bandwidth estimate ramps up
    const steady = await measure(room, room.people, 6, true);
    const params = (await a.page.evaluate((id) => window.gc.senderParams(id), b.id)) as { video?: { maxBitrate?: number }; audio?: { maxBitrate?: number } };
    expect(params.video?.maxBitrate).toBe(1_500_000);
    expect(params.audio?.maxBitrate).toBe(32_000);
    const paths = (await room.parts(a)).map((p) => p.path);

    // Chitra leaves: the other three stay connected; then she rejoins the running call.
    await c.page.evaluate(() => window.gc.leave());
    for (const p of [a, b, d]) await expect.poll(async () => (await room.parts(p)).find((x) => x.id === c.id)?.state, { timeout: 20_000 }).toBe('left');
    expect(await c.page.evaluate(() => window.gc.call())).toBeNull();
    const three = await measure(room, [a, b, d], 3, true);
    await c.page.evaluate((x) => window.gc.join(x), cid);
    await allConnected(room, room.people);
    const rejoined = await measure(room, room.people, 4, true);

    // Bala shares the screen: it replaces his camera on all three connections.
    await b.page.click('#share');
    for (const p of [a, c, d]) await expect.poll(() => p.page.evaluate(() => window.gc.screenBy()), { timeout: 20_000 }).toBe(b.id);
    expect(await b.page.evaluate(() => window.gc.screenBy())).toBe(b.id);
    await new Promise((r) => setTimeout(r, 3000));
    const sharing = await measure(room, room.people, 4, true);
    const fromBala = await Promise.all([a, c, d].map(async (p) => ((await p.page.evaluate(() => window.gc.stats())) as Record<string, PairStats>)[b.id]));
    // One at a time: Dev can't start while Bala shares.
    await d.page.click('#share');
    await expect.poll(() => d.page.evaluate(() => window.gc.shareError()), { timeout: 10_000 }).toMatch(/Bala is sharing/);
    await b.page.evaluate(() => window.gc.stopScreen());
    for (const p of [a, c, d]) await expect.poll(() => p.page.evaluate(() => window.gc.screenBy()), { timeout: 20_000 }).toBeNull();

    console.log(
      'GROUP CALL 4 VIDEO',
      JSON.stringify({ setupMs, connect, early, steady, paths, afterLeave3: three, afterRejoin: rejoined, whileSharing: sharing, screenFromBala: fromBala.map((s) => `${s.frameWidth}x${s.frameHeight}`) }, null, 1),
    );
  } finally {
    await room.close();
  }
});

test('6 people on voice only: everyone hears everyone', async ({ browser }) => {
  test.setTimeout(300_000);
  const room = new Room(browser);
  try {
    const names = ['Asha', 'Bala', 'Chitra', 'Dev', 'Esha', 'Farhan'];
    for (const n of names) await room.add(n);
    await room.setup();
    const [a, ...rest] = room.people;
    const t0 = Date.now();
    await ring(room, a, false, rest);
    await allConnected(room, room.people);
    const setupMs = Date.now() - t0;
    const connect = await connectTimes(room);
    await new Promise((r) => setTimeout(r, 3000));
    const m = await measure(room, room.people, 6, false);
    expect(m.pairs).toBe(30);
    const params = (await a.page.evaluate((id) => window.gc.senderParams(id), rest[0].id)) as { audio?: { maxBitrate?: number } };
    expect(params.audio?.maxBitrate).toBe(32_000);
    console.log('GROUP CALL 6 VOICE', JSON.stringify({ setupMs, connect, ...m }, null, 1));
  } finally {
    await room.close();
  }
});

test('6 people on video: bitrate steps down to 300 kbit/s per copy', async ({ browser }) => {
  test.setTimeout(420_000);
  const room = new Room(browser);
  try {
    const names = ['Asha', 'Bala', 'Chitra', 'Dev', 'Esha', 'Farhan'];
    for (const n of names) await room.add(n);
    await room.setup();
    const [a, ...rest] = room.people;
    const t0 = Date.now();
    await ring(room, a, true, rest);
    await allConnected(room, room.people, 90_000);
    const setupMs = Date.now() - t0;
    const connect = await connectTimes(room);
    await new Promise((r) => setTimeout(r, 8000));
    const m = await measure(room, room.people, 6, true);
    expect(m.pairs).toBe(30);
    const params = (await a.page.evaluate((id) => window.gc.senderParams(id), rest[0].id)) as { video?: { maxBitrate?: number; scaleResolutionDownBy?: number } };
    expect(params.video).toMatchObject({ maxBitrate: 300_000, scaleResolutionDownBy: 2 });
    expect(m.videoKbps!.max).toBeLessThan(400); // the cap holds (300k + a little measuring slack)
    console.log('GROUP CALL 6 VIDEO', JSON.stringify({ setupMs, connect, ...m }, null, 1));
  } finally {
    await room.close();
  }
});

