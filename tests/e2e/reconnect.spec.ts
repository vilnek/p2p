import { expect, test, type Browser, type Page } from '@playwright/test';
import { People, fragment, makeInvite } from './fixtures';
import { CONNECTED, join, makeAccount } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// BUG-8: a 1:1 video call survives a network stall. One side's whole page process is stopped
// (SIGSTOP) for a while, so its ICE checks, media and data channel all go silent at once, exactly as
// when a phone switches between Wi-Fi and 4G. The other side must say "Reconnecting…" (never
// "Call ended"), restart ICE, and both must be back in the call with video flowing.

// One at a time in this file: each test stops a browser process for a while.
test.describe.configure({ mode: 'serial' });

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.afterEach(async () => people.close());

/** Keeps the page's RTCPeerConnections and how many ICE restarts (new local ufrag) each made. */
const TRACK = () => {
  const Real = window.RTCPeerConnection;
  const w = window as unknown as { __pcs: RTCPeerConnection[]; __ufrags: string[] };
  w.__pcs = [];
  w.__ufrags = [];
  window.RTCPeerConnection = function (this: unknown, ...a: ConstructorParameters<typeof RTCPeerConnection>) {
    const pc = new Real(...a);
    w.__pcs.push(pc);
    const set = pc.setLocalDescription.bind(pc);
    pc.setLocalDescription = async (d?: RTCLocalSessionDescriptionInit) => {
      await set(d as RTCLocalSessionDescriptionInit);
      const u = pc.localDescription?.sdp.match(/^a=ice-ufrag:(\S+)/m)?.[1];
      if (u && w.__ufrags.at(-1) !== u) w.__ufrags.push(u);
    };
    return pc;
  } as unknown as typeof RTCPeerConnection;
  window.RTCPeerConnection.prototype = Real.prototype;
};

/** The renderer process ids of the browser right now (Chrome DevTools protocol). */
async function renderers(browser: Browser): Promise<Set<number>> {
  const cdp = await browser.newBrowserCDPSession();
  const info = (await cdp.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; id: number }[] };
  await cdp.detach();
  return new Set(info.processInfo.filter((p) => p.type === 'renderer').map((p) => p.id));
}

async function framesIn(p: Page): Promise<number> {
  return p.evaluate(async () => {
    let n = 0;
    for (const pc of (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs)
      if (pc.connectionState !== 'closed') (await pc.getStats()).forEach((r) => r.type === 'inbound-rtp' && r.kind === 'video' && (n += r.framesDecoded ?? 0));
    return n;
  });
}

/** Answers within `ms`? (A stopped renderer never answers until it is continued.) */
async function answers(p: Page, ms: number): Promise<boolean> {
  return Promise.race([p.evaluate(() => true).catch(() => false), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
}

/**
 * The renderer processes that run B's page and nothing of A's: each new renderer is stopped for a
 * moment, and kept only if B goes silent while A still answers. (With 2 workers each has its own
 * browser, but Chrome may start spare renderers or put pages together under load: never guess.)
 */
async function processesOnlyOf(b: Page, a: Page, candidates: number[]): Promise<number[]> {
  const out: number[] = [];
  for (const pid of candidates) {
    try {
      process.kill(pid, 'SIGSTOP');
    } catch {
      continue; // gone
    }
    let bSilent = false;
    let aAnswers = false;
    try {
      [bSilent, aAnswers] = await Promise.all([answers(b, 1500).then((x) => !x), answers(a, 1500)]);
    } finally {
      process.kill(pid, 'SIGCONT');
    }
    await answers(b, 5000); // let B catch up before the next probe
    if (bSilent && aAnswers) out.push(pid);
  }
  return out;
}

const restarts = (p: Page) => p.evaluate(() => (window as unknown as { __ufrags: string[] }).__ufrags.length - 1);

/** Records every call-status text the page shows, in order. */
async function recordStatus(p: Page): Promise<void> {
  await p.evaluate(() => {
    const w = window as unknown as { __status: string[] };
    w.__status = [];
    new MutationObserver(() => {
      const s = document.querySelector('[data-testid=call-status]')?.textContent ?? '';
      const kind = /^\d\d:\d\d$/.test(s) ? 'live' : s;
      if (s && w.__status.at(-1) !== kind) w.__status.push(kind);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}
const statuses = (p: Page) => p.evaluate(() => (window as unknown as { __status: string[] }).__status);

for (const [stallS, viaRelays] of [[10, false], [14, false], [14, true]] as const) {
  const how = viaRelays ? ' (restart offer through the relays only)' : '';
  test(`video call: the other side stalls ${stallS} s → "Reconnecting…", then connected again with video${how}`, async ({ browser }) => {
    test.setTimeout(150_000);
    people = new People(browser, () => relay);
    const before = await renderers(browser);
    const actx = await people.context();
    await actx.addInitScript(TRACK);
    const a = await people.page(actx, 'A');
    await a.goto(people.q(viaRelays ? '&restartViaRelays=1' : ''));
    await makeAccount(a, 'Asha');
    const link = await makeInvite(a);
    const bctx = await people.context();
    await bctx.addInitScript(TRACK);
    const b = await people.page(bctx, 'B');
    await b.goto(`${people.q(viaRelays ? '&restartViaRelays=1' : '')}${fragment(link)}`);
    await join(b, 'Ravi');
    await expect(b.getByTestId('peer-name')).toHaveText('Asha', { timeout: 30_000 });
    const after = await renderers(browser);
    const bPids = await processesOnlyOf(b, a, [...after].filter((x) => !before.has(x)));
    expect(bPids.length, "no renderer process runs B's page alone").toBeGreaterThan(0);

    await expect(a.getByTestId('presence')).toHaveText('online', { timeout: 20_000 });
    await b.getByTestId('video-call').click();
    await a.getByTestId('accept').click();
    await expect(a.getByTestId('call-status')).toHaveText(CONNECTED, { timeout: 25_000 });
    await expect(b.getByTestId('call-status')).toHaveText(CONNECTED, { timeout: 25_000 });
    await recordStatus(a);
    await recordStatus(b);

    // B's page goes silent: no ICE answers, no media, no data channel.
    for (const pid of bPids) process.kill(pid, 'SIGSTOP');
    try {
      // Chrome notices the silence after ~3–7 s (later on a busy machine).
      const t0 = Date.now();
      await expect(a.getByTestId('call-status')).toHaveText('Reconnecting…', { timeout: stallS * 1000 - 500 });
      await a.waitForTimeout(Math.max(0, stallS * 1000 - (Date.now() - t0)));
    } finally {
      for (const pid of bPids) process.kill(pid, 'SIGCONT');
    }

    // Both back in the call (the timer runs on), with video flowing both ways.
    await expect(a.getByTestId('call-status')).toHaveText(CONNECTED, { timeout: 25_000 });
    await expect(b.getByTestId('call-status')).toHaveText(CONNECTED, { timeout: 25_000 });
    const fa = await framesIn(a);
    const fb = await framesIn(b);
    await expect.poll(() => framesIn(a), { timeout: 10_000 }).toBeGreaterThan(fa + 10);
    await expect.poll(() => framesIn(b), { timeout: 10_000 }).toBeGreaterThan(fb + 10);
    const sa = await statuses(a);
    const sb = await statuses(b);
    const ra = await restarts(a);
    const rb = await restarts(b);
    console.log(`stall ${stallS} s: A shown ${JSON.stringify(sa)}, B shown ${JSON.stringify(sb)}, ICE restarts A ${ra} B ${rb}`);
    expect(sa).toContain('Reconnecting…');
    for (const s of [...sa, ...sb]) expect(s).not.toBe('Call ended');
    if (stallS > 10) expect(ra + rb).toBeGreaterThan(0); // long enough that ICE was restarted

    // The call ends normally.
    await a.getByTestId('hang-up').click();
    await expect(b.getByTestId('call-status')).toHaveText('Call ended', { timeout: 15_000 });
  });
}
