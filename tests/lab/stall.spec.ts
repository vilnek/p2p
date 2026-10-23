import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';
import { fragment, join, makeAccount, makeInvite, metric } from './lab';
import { startLabRelay, type LabRelay } from './lab-relay';

// TEST LAB · network stall in a 1:1 video call (BUG-8). B's renderer processes are frozen (SIGSTOP) for
// N seconds: ICE, media and the data channel all go silent at once, like a Wi-Fi ⇄ 4G switch. After
// they wake up, both sides must agree: back in the call (timer running, video flowing) for short
// stalls; for long ones, both ended (never one side in the call and the other not).
const BASE = `http://127.0.0.1:${process.env.LAB_PORT || 4327}`;
const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
let relay: LabRelay;
const open: { ctx: BrowserContext; dir: string }[] = [];
test.beforeAll(async () => (relay = await startLabRelay()));
test.afterAll(async () => relay.stop());
test.afterEach(async () => {
  for (const s of open.splice(0)) {
    await s.ctx.close().catch(() => undefined);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

async function side(label: string, path: string): Promise<{ page: Page; dir: string }> {
  const dir = pjoin(tmpdir(), `p2p-lab-stall-${label}-${Date.now()}`);
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chrome', headless: true, args: ARGS, permissions: ['camera', 'microphone'], baseURL: BASE });
  open.push({ ctx, dir });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(path);
  return { page, dir };
}
/** PIDs of the renderer processes of the Chrome that uses this profile folder. */
function renderers(dir: string): number[] {
  return execSync('ps -axo pid=,command=')
    .toString()
    .split('\n')
    .filter((l) => l.includes('--type=renderer') && l.includes(dir.split('/').pop()!))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}
function rendererPidsFor(dir: string): number[] {
  // Renderers don't carry --user-data-dir; find the browser process, then its renderer children.
  const rows = execSync('ps -axo pid=,ppid=,command=').toString().split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean) as RegExpMatchArray[];
  const main = rows.find((r) => r[3].includes(`--user-data-dir=${dir}`) && !r[3].includes('--type='));
  const direct = renderers(dir);
  if (!main) return direct;
  return [...new Set([...direct, ...rows.filter((r) => r[2] === main[1] && r[3].includes('--type=renderer')).map((r) => Number(r[1]))])];
}

const q = (extra = '') => `/p2p.html?relays=${encodeURIComponent(relay.url)}${extra}`;
const timer = async (p: Page) => ((await p.getByTestId('call-screen').count()) ? ((await p.getByTestId('call-status').textContent()) ?? '') : 'no call screen');
const live = (s: string) => /^\d\d:\d\d(:\d\d)?$/.test(s);

for (const secs of [10, 25, 45]) {
  test(`video call, B frozen ${secs} s: both sides end in the same state; short stalls come back`, async () => {
    test.setTimeout(6 * 60_000);
    const A = await side('A', q());
    await makeAccount(A.page, 'Asha');
    const link = await makeInvite(A.page);
    const B = await side('B', `${q()}${fragment(link)}`);
    await join(B.page, 'Ravi');
    await expect(A.page.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 30_000 });
    await B.page.getByTestId('video-call').click();
    await A.page.getByTestId('accept').click();
    await expect(A.page.getByTestId('call-status')).toHaveText(/^\d\d:\d\d$/, { timeout: 30_000 });
    await A.page.waitForTimeout(5000);
    const pids = rendererPidsFor(B.dir);
    expect(pids.length, 'no renderer found for B').toBeGreaterThan(0);
    const seenA: string[] = [];
    execSync(`kill -STOP ${pids.join(' ')}`);
    const t0 = Date.now();
    while (Date.now() - t0 < secs * 1000) {
      const s = await timer(A.page);
      if (seenA.at(-1) !== s.replace(/\d\d:\d\d/, 'mm:ss')) seenA.push(s.replace(/\d\d:\d\d/, 'mm:ss'));
      await A.page.waitForTimeout(1000);
    }
    execSync(`kill -CONT ${pids.join(' ')}`);
    const t1 = Date.now();
    let a = '';
    let b = '';
    // Up to 40 s to settle.
    while (Date.now() - t1 < 40_000) {
      a = await timer(A.page);
      b = await timer(B.page);
      if (seenA.at(-1) !== a.replace(/\d\d:\d\d/, 'mm:ss')) seenA.push(a.replace(/\d\d:\d\d/, 'mm:ss'));
      if (live(a) && live(b)) break;
      await A.page.waitForTimeout(1000);
    }
    const settleS = (Date.now() - t1) / 1000;
    metric(`stall-${secs}s`, { a, b, backInCall: live(a) && live(b), settleS, aSaw: seenA });
    expect(live(a), `A "${a}" vs B "${b}"`).toBe(live(b));
    if (secs <= 10) expect(live(a) && live(b), 'a 10 s stall should come back').toBe(true);
    expect(seenA.some((s) => s === 'Call ended') && live(a), 'A showed "Call ended" and then came back').toBe(false);
  });
}
