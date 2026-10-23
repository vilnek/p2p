import { expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { Lab, makeAccount, metric, paste, say, showCard } from './lab';
import { startLabRelay, type LabRelay } from './lab-relay';

// TEST LAB · Chrome ⇄ WebKit (Playwright WebKit, the closest to iPhone Safari on a Mac): make an
// account, one-scan both ways, chat, video call. Local lab relay only.
let relay: LabRelay;
let wk: Browser;
let lab: Lab;
let wkLab: Lab;
test.beforeAll(async () => {
  relay = await startLabRelay();
  wk = await webkit.launch({ channel: undefined });
});
test.afterAll(async () => {
  await wk.close();
  await relay.stop();
});
test.beforeEach(({ browser }) => {
  lab = new Lab(browser, () => relay);
  wkLab = new Lab(wk, () => relay);
});
test.afterEach(async () => {
  await lab.close();
  await wkLab.close();
});

const BASE = `http://127.0.0.1:${process.env.LAB_PORT || 4327}`;
async function wkPerson(name: string): Promise<Page> {
  const ctx = await wkLab.context({ baseURL: BASE, permissions: ['camera', 'microphone'] });
  const p = await wkLab.page(ctx, `${name}(webkit)`);
  await p.goto(wkLab.q());
  await makeAccount(p, name);
  return p;
}

for (const shower of ['chrome', 'webkit'] as const) {
  test(`one-scan (${shower} shows the code), chat both ways, video call: Chrome ⇄ WebKit`, async () => {
    const c = (await lab.person('Asha')).page;
    const w = await wkPerson('Ravi');
    const [show, scan] = shower === 'chrome' ? [c, w] : [w, c];
    const t0 = Date.now();
    await paste(scan, await showCard(show));
    await expect(scan.getByTestId('peer-name')).toHaveText(shower === 'chrome' ? 'Asha' : 'Ravi', { timeout: 40_000 });
    await expect(show.getByTestId('peer-name')).toHaveText(shower === 'chrome' ? 'Ravi' : 'Asha', { timeout: 40_000 });
    const connectS = (Date.now() - t0) / 1000;
    await say(c, 'from chrome');
    await expect(w.getByTestId('msg-them').last()).toContainText('from chrome', { timeout: 20_000 });
    await say(w, 'from webkit');
    await expect(c.getByTestId('msg-them').last()).toContainText('from webkit', { timeout: 20_000 });
    // Video call: WebKit calls, Chrome answers.
    let call = 'connected';
    try {
      await w.getByTestId('video-call').click();
      await c.getByTestId('accept').click({ timeout: 20_000 });
      await expect(w.getByTestId('call-status')).toHaveText(/^\d\d:\d\d$/, { timeout: 30_000 });
      await expect(c.getByTestId('call-status')).toHaveText(/^\d\d:\d\d$/, { timeout: 30_000 });
      await w.getByTestId('hang-up').click();
      await expect(c.getByTestId('call-status')).toHaveText('Call ended', { timeout: 15_000 });
    } catch (e) {
      call = `failed: ${(e as Error).message.split('\n')[0]} · webkit call screen: ${await w.getByTestId('call-status').textContent().catch(() => 'none')}`;
    }
    metric(`webkit-${shower}-shows`, { connectS, call });
    expect(call).toBe('connected');
    expect([...lab.errors, ...wkLab.errors]).toEqual([]);
  });
}
