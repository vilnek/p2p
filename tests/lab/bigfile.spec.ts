import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createHash, createCipheriv } from 'node:crypto';
import { execSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';
import { fragment, join, makeAccount, makeInvite, metric, openContact, tab } from './lab';
import { startLabRelay, type LabRelay } from './lab-relay';

// TEST LAB · big files. Each person is a separate Chrome (own profile folder) so the lab can read each
// side's real memory (RSS of the whole Chrome process tree) as well as the page's JS heap.
//   LAB_BIG_MB (default 2048): size of the big file. LAB_TMP: where the generated file lives.

const BIG_MB = Number(process.env.LAB_BIG_MB || 2048);
const TMP = process.env.LAB_TMP || pjoin(tmpdir(), 'p2p-lab');
const BASE = `http://127.0.0.1:${process.env.LAB_PORT || 4327}`;
const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-precise-memory-info'];

/** A deterministic, not-compressible file written in 8 MB pieces (never whole in memory); returns its SHA-256. */
async function bigFile(mb: number): Promise<{ path: string; sha: string }> {
  mkdirSync(TMP, { recursive: true });
  const path = pjoin(TMP, `lab-${mb}MB.bin`);
  if (existsSync(path) && existsSync(path + '.sha') && statSync(path).size === mb * 1048576) return { path, sha: readFileSync(path + '.sha', 'utf8') };
  const cipher = createCipheriv('aes-128-ctr', Buffer.alloc(16, 7), Buffer.alloc(16, 0));
  const hash = createHash('sha256');
  const out = createWriteStream(path);
  const zero = Buffer.alloc(8 * 1048576);
  for (let i = 0; i < mb / 8; i++) {
    const piece = cipher.update(zero);
    hash.update(piece);
    if (!out.write(piece)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((r) => out.end(r));
  const sha = hash.digest('hex');
  writeFileSync(path + '.sha', sha);
  return { path, sha };
}

/** RSS (MB) of a Chrome main process and everything under it. */
function treeRssMB(rootPid: number): number {
  const rows = execSync('ps -axo pid=,ppid=,rss=').toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map<number, number[]>();
  for (const [pid, ppid] of rows) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  const rss = new Map(rows.map(([pid, , r]) => [pid, r]));
  let sum = 0;
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop()!;
    sum += rss.get(p) ?? 0;
    stack.push(...(kids.get(p) ?? []));
  }
  return sum / 1024;
}
function chromePid(userDir: string): number {
  const line = execSync('ps -axo pid=,command=').toString().split('\n').find((l) => l.includes(`--user-data-dir=${userDir}`) && !l.includes('--type='));
  return Number(line?.trim().split(/\s+/)[0] ?? 0);
}

interface Side {
  ctx: BrowserContext;
  page: Page;
  dir: string;
  pid: number;
}
let relay: LabRelay;
const sides: Side[] = [];
test.beforeAll(async () => (relay = await startLabRelay()));
test.afterAll(async () => relay.stop());
test.afterEach(async () => {
  for (const s of sides.splice(0)) {
    await s.ctx.close().catch(() => undefined);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

async function side(label: string, extra: string): Promise<Side> {
  const dir = pjoin(TMP, `profile-${label}-${Date.now()}`);
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chrome', headless: true, args: ARGS, permissions: ['camera', 'microphone'], baseURL: BASE });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('pageerror', (e) => console.log(label, 'pageerror', e.message));
  await page.goto(`/p2p.html?relays=${encodeURIComponent(relay.url)}${extra}`);
  const s = { ctx, page, dir, pid: chromePid(dir) };
  sides.push(s);
  return s;
}

async function pairUp(extra: string): Promise<{ A: Side; B: Side }> {
  const A = await side('A', extra);
  await makeAccount(A.page, 'Asha');
  const link = await makeInvite(A.page);
  const B = await side('B', '');
  await B.page.goto(`/p2p.html?relays=${encodeURIComponent(relay.url)}${fragment(link)}`);
  await join(B.page, 'Ravi');
  await expect(A.page.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 30_000 });
  await expect(B.page.getByTestId('peer-name')).toHaveText('Asha', { timeout: 30_000 });
  // The page's CSP blocks injected <script> tags; evaluate() is not subject to it.
  await B.page.evaluate(readFileSync('tests/lab/page-sha256.js', 'utf8'));
  return { A, B };
}

const heap = (p: Page) => p.evaluate(() => ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576).catch(() => 0);

/** Samples memory every 2 s until stopped. */
function sampler(A: Side, B: Side) {
  const s = { aHeap: 0, bHeap: 0, aRss: 0, bRss: 0, aRss0: treeRssMB(A.pid), bRss0: treeRssMB(B.pid), samples: 0 };
  let on = true;
  const loop = (async () => {
    while (on) {
      s.aHeap = Math.max(s.aHeap, await heap(A.page));
      s.bHeap = Math.max(s.bHeap, await heap(B.page));
      s.aRss = Math.max(s.aRss, treeRssMB(A.pid));
      s.bRss = Math.max(s.bRss, treeRssMB(B.pid));
      s.samples++;
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
  return { s, stop: async () => ((on = false), await loop, s) };
}

async function sendPath(a: Page, path: string): Promise<void> {
  await a.getByTestId('attach').click();
  const chooser = a.waitForEvent('filechooser');
  await a.getByTestId('pick-files').click();
  await (await chooser).setFiles(path);
}

async function receivedSha(b: Page, name: string, size: number): Promise<string> {
  const files = await b.evaluate(() => (window as unknown as { __labOpfs(): Promise<{ name: string; size: number }[]> }).__labOpfs());
  const f = files.find((x) => x.name.endsWith(name) && x.size === size);
  if (!f) throw new Error(`received file not found in the private file area: ${JSON.stringify(files)}`);
  return b.evaluate((n) => (window as unknown as { __labOpfsSha(n: string): Promise<string> }).__labOpfsSha(n), f.name);
}
const pctOf = async (b: Page) => Number(((await b.getByTestId('file-them').getByTestId('file-line').textContent().catch(() => '')) ?? '').match(/^(\d+)%/)?.[1] ?? -1);

for (const withDrop of [false, true]) {
  test(`${BIG_MB} MB file between two Chromes${withDrop ? ', connection dropped at 40 %, resumed' : ''}: SHA-256 equal, memory flat, MB/s`, async () => {
    test.setTimeout(45 * 60_000);
    const { path, sha } = await bigFile(BIG_MB);
    const { A, B } = await pairUp(withDrop ? '&testHooks=1' : '');
    const mem = sampler(A, B);
    await sendPath(A.page, path);
    await B.page.getByTestId('file-accept').click({ timeout: 30_000 });
    const t0 = Date.now();
    let resumedAt = -1;
    let dropAt = -1;
    if (withDrop) {
      await expect.poll(() => pctOf(B.page), { timeout: 10 * 60_000, intervals: [500] }).toBeGreaterThanOrEqual(40);
      dropAt = await pctOf(B.page);
      await A.page.evaluate(() => (window as unknown as { __p2pTest: { drop(): void } }).__p2pTest.drop());
      await expect(B.page.getByTestId('file-them')).toHaveAttribute('data-state', 'waiting', { timeout: 30_000 });
      await openContact(A.page);
      await expect.poll(() => pctOf(B.page), { timeout: 60_000, intervals: [250] }).toBeGreaterThanOrEqual(0);
      resumedAt = await pctOf(B.page);
    }
    await expect(B.page.getByTestId('file-them')).toHaveAttribute('data-state', 'done', { timeout: 40 * 60_000 });
    const secs = (Date.now() - t0) / 1000;
    const m = await mem.stop();
    const got = await receivedSha(B.page, `lab-${BIG_MB}MB.bin`, BIG_MB * 1048576);
    const du = Number(execSync(`du -sm "${B.dir}"`).toString().split(/\s/)[0]);
    metric(`bigfile-${BIG_MB}MB${withDrop ? '-drop40' : ''}`, {
      shaEqual: got === sha,
      seconds: secs,
      MBps: +(BIG_MB / secs).toFixed(1),
      dropAtPct: dropAt,
      resumedAtPct: resumedAt,
      peakHeapMB: { A: +m.aHeap.toFixed(0), B: +m.bHeap.toFixed(0) },
      rssMB: { A0: +m.aRss0.toFixed(0), Apeak: +m.aRss.toFixed(0), B0: +m.bRss0.toFixed(0), Bpeak: +m.bRss.toFixed(0) },
      receiverProfileMB: du,
    });
    expect(got).toBe(sha);
    if (withDrop) expect(resumedAt, 'resume started again from 0 %').toBeGreaterThanOrEqual(dropAt - 5);
    // Memory: never anywhere near the file size.
    expect(m.aHeap).toBeLessThan(400);
    expect(m.bHeap).toBeLessThan(400);
    expect(m.bRss - m.bRss0).toBeLessThan(BIG_MB / 2);
  });
}

test('200 small files in a row (1–64 KB): all arrive, each checked, in order', async () => {
  test.setTimeout(15 * 60_000);
  const { A, B } = await pairUp('');
  // B writes first, so A is no longer a "new contact" and small files come in without Accept.
  await B.page.getByTestId('message-input').fill('send them');
  await B.page.getByTestId('send').click();
  await expect(A.page.getByTestId('msg-them').last()).toContainText('send them');
  const files = Array.from({ length: 200 }, (_, i) => {
    const size = 1024 + ((i * 7919) % (63 * 1024));
    const buffer = Buffer.alloc(size, i % 251);
    buffer.writeUInt32LE(i, 0);
    return { name: `small-${String(i).padStart(3, '0')}.bin`, mimeType: 'application/octet-stream', buffer, sha: createHash('sha256').update(buffer).digest('hex') };
  });
  const t0 = Date.now();
  await A.page.getByTestId('attach').click();
  const chooser = A.page.waitForEvent('filechooser');
  await A.page.getByTestId('pick-files').click();
  await (await chooser).setFiles(files.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })));
  const states = (p: Page, id: string) =>
    p.evaluate((id) => {
      const h: Record<string, number> = {};
      for (const el of document.querySelectorAll(`[data-testid=${id}]`)) h[el.getAttribute('data-state') ?? '?'] = (h[el.getAttribute('data-state') ?? '?'] ?? 0) + 1;
      const lines = [...document.querySelectorAll(`[data-testid=${id}]:not([data-state=done]) [data-testid=file-line]`)].slice(0, 3).map((e) => e.textContent);
      return { h, lines };
    }, id);
  const end = Date.now() + 6 * 60_000;
  let doneB = 0;
  while (Date.now() < end && (doneB = await B.page.locator('[data-testid=file-them][data-state=done]').count()) < 200) {
    await B.page.waitForTimeout(30_000);
    console.log('200-files', ((Date.now() - t0) / 1000).toFixed(0), 's  A:', JSON.stringify(await states(A.page, 'file-me')), ' B:', JSON.stringify(await states(B.page, 'file-them')));
  }
  if (doneB < 200) metric('200-small-files', { fail: true, doneB, A: await states(A.page, 'file-me'), B: await states(B.page, 'file-them') });
  expect(doneB).toBe(200);
  const secs = (Date.now() - t0) / 1000;
  await expect(A.page.locator('[data-testid=file-me][data-state=done]')).toHaveCount(200, { timeout: 60_000 });
  const inOpfs = await B.page.evaluate(() => (window as unknown as { __labOpfs(): Promise<{ name: string; size: number }[]> }).__labOpfs());
  let bad = 0;
  for (const f of files) {
    const hit = inOpfs.find((x) => x.name.endsWith(f.name));
    if (!hit || (await B.page.evaluate((n) => (window as unknown as { __labOpfsSha(n: string): Promise<string> }).__labOpfsSha(n), hit.name)) !== f.sha) bad++;
  }
  const failed = await B.page.locator('[data-testid=file-them][data-state=failed]').count();
  metric('200-small-files', { seconds: secs, filesPerS: +(200 / secs).toFixed(1), shaMismatchOrMissing: bad, failed, heapB: +(await heap(B.page)).toFixed(0) });
  expect(bad).toBe(0);
  // Chat still answers after the burst.
  await tab(B.page, 'chats');
});
