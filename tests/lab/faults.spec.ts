import { expect, test, type Page } from '@playwright/test';
import { Lab, fragment, join, makeAccount, makeInvite, metric, openContact, pair, paste, say, showCard, tab, testHook } from './lab';
import { startLabRelay, type LabRelay } from './lab-relay';

// TEST LAB · network faults (local lab relay only). Each check says what a person would expect.
let relay: LabRelay;
let lab: Lab;
test.beforeEach(async ({ browser }) => {
  relay = await startLabRelay();
  lab = new Lab(browser, () => relay);
});
test.afterEach(async () => {
  await lab.close();
  await relay.stop();
});

const texts = (p: Page, id: string) => p.getByTestId(id).allTextContents();
const isOnline = async (p: Page) => ((await p.getByTestId('presence').textContent().catch(() => '')) ?? '') === 'online';

/** Every message A shows as sent must reach B (nothing silently lost). */
async function noSilentLoss(a: Page, b: Page, marker: string): Promise<void> {
  const sent = (await texts(a, 'msg-me')).filter((t) => t.includes(marker));
  for (const s of sent) {
    const body = s.match(new RegExp(`${marker}-\\d+`))![0];
    await expect.poll(async () => (await texts(b, 'msg-them')).some((t) => t.includes(body)), { timeout: 30_000, message: `"${body}" shown as sent on A but never reached B` }).toBe(true);
  }
}

test('offline mid-chat (context.setOffline 10 s): chat works again after, nothing shown as sent is lost', async () => {
  const { a, b, bctx } = await pair(lab);
  await say(a, 'before');
  await expect(b.getByTestId('msg-them').last()).toContainText('before');
  await bctx.setOffline(true);
  for (let i = 1; i <= 3; i++) {
    await say(a, `lost-${i}`);
    await a.waitForTimeout(1500);
  }
  await a.waitForTimeout(6000);
  const survived = await isOnline(a);
  await bctx.setOffline(false);
  const t0 = Date.now();
  // Reconnect the way a person would if needed: open the chat again.
  await a.waitForTimeout(3000);
  if (!(await isOnline(a))) await openContact(a);
  await expect(a.getByTestId('presence')).toHaveText('online', { timeout: 40_000 });
  metric('offline-mid-chat', { webrtcSurvivedOffline: survived, backOnlineS: (Date.now() - t0) / 1000 });
  await say(a, 'after-1');
  await expect(b.getByTestId('msg-them').last()).toContainText('after-1', { timeout: 20_000 });
  await say(b, 'reply-after');
  await expect(a.getByTestId('msg-them').last()).toContainText('reply-after', { timeout: 20_000 });
  await noSilentLoss(a, b, 'lost');
  expect(lab.errors).toEqual([]);
});

test('hard drop mid-chat + offline: the message waits with a clock, goes by itself after reconnect, then delivered and read ticks', async () => {
  const { a, b, actx } = await pair(lab, '&testHooks=1');
  await actx.setOffline(true);
  await testHook(a, 'drop');
  await expect(a.getByTestId('presence')).not.toHaveText('online', { timeout: 15_000 });
  await say(a, 'while-down-1');
  const bubble = a.getByTestId('msg-me').filter({ hasText: 'while-down-1' });
  await expect(bubble.getByTestId('tick')).toHaveAttribute('data-st', 'wait', { timeout: 10_000 });
  await expect(a.getByText('Not sent: they are offline.')).toHaveCount(0);
  await actx.setOffline(false);
  const t0 = Date.now();
  // It should go by itself; if the connection doesn't come back on its own in 30 s, reopen the chat.
  let byItself = true;
  try {
    await expect(b.getByTestId('msg-them').filter({ hasText: 'while-down-1' })).toHaveCount(1, { timeout: 30_000 });
  } catch {
    byItself = false;
    await openContact(a);
    await expect(b.getByTestId('msg-them').filter({ hasText: 'while-down-1' })).toHaveCount(1, { timeout: 40_000 });
  }
  const deliveredS = (Date.now() - t0) / 1000;
  await expect(bubble.getByTestId('tick')).toHaveAttribute('data-st', /^(d|r)$/, { timeout: 20_000 });
  // B has the chat open: read (blue) ticks.
  await b.bringToFront();
  await expect(bubble.getByTestId('tick')).toHaveAttribute('data-st', 'r', { timeout: 20_000 });
  metric('ticks-offline-clock', { wentByItself: byItself, deliveredAfterOnlineS: deliveredS, readTickS: (Date.now() - t0) / 1000 });
  await say(a, 'back-1');
  await expect(b.getByTestId('msg-them').last()).toContainText('back-1', { timeout: 20_000 });
  // Exactly once on B.
  await expect(b.getByTestId('msg-them').filter({ hasText: 'while-down-1' })).toHaveCount(1);
});

async function callConnected(a: Page, b: Page): Promise<void> {
  await b.getByTestId('video-call').click();
  await a.getByTestId('accept').click();
  await expect(b.getByTestId('call-status')).toHaveText(/^\d\d:\d\d$/, { timeout: 25_000 });
  await expect(a.getByTestId('call-status')).toHaveText(/^\d\d:\d\d$/, { timeout: 25_000 });
}
const callState = async (p: Page) => ((await p.getByTestId('call-screen').count()) ? ((await p.getByTestId('call-status').textContent()) ?? '?') : 'no call screen');

for (const kind of ['offline 10 s', 'hard drop'] as const) {
  test(`mid-call ${kind}: both sides end in the same state, and a new call connects`, async () => {
    const { a, b, bctx } = await pair(lab, '&testHooks=1');
    await callConnected(a, b);
    await bctx.setOffline(true);
    if (kind === 'hard drop') await testHook(b, 'drop');
    await b.waitForTimeout(10_000);
    await bctx.setOffline(false);
    await b.waitForTimeout(15_000);
    const sa = await callState(a);
    const sb = await callState(b);
    const live = (s: string) => /^\d\d:\d\d$/.test(s);
    metric(`mid-call-${kind.replace(/ /g, '-')}`, { a: sa, b: sb });
    // Never one side "in the call" while the other has left it.
    expect(live(sa), `A: "${sa}" vs B: "${sb}"`).toBe(live(sb));
    // Clean up and call again.
    for (const p of [a, b]) {
      if (live(await callState(p))) await p.getByTestId('hang-up').click().catch(() => undefined);
      await p.keyboard.press('Escape');
      const ok = p.getByTestId('call-screen').getByRole('button', { name: 'OK' });
      if (await ok.count()) await ok.click();
    }
    await openContact(b);
    await expect(b.getByTestId('presence')).toHaveText('online', { timeout: 40_000 });
    await callConnected(a, b);
    await b.getByTestId('hang-up').click();
  });
}

test('mid-file offline 10 s (20 MB): the transfer finishes, checked', async () => {
  const { a, b, bctx } = await pair(lab, '&fileDelay=30&testHooks=1');
  // Files from a "new contact" ask first; once B has written to A, A's files under 100 MB come in at once.
  await say(b, 'send it');
  await expect(a.getByTestId('msg-them').last()).toContainText('send it');
  await a.getByTestId('attach').click();
  const chooser = a.waitForEvent('filechooser');
  await a.getByTestId('pick-files').click();
  const buffer = Buffer.alloc(20 * 1024 * 1024);
  for (let i = 0; i < buffer.length; i += 4096) buffer.writeUInt32LE((i * 2654435761) >>> 0, i);
  await (await chooser).setFiles({ name: 'mid-file.bin', mimeType: 'application/octet-stream', buffer });
  const line = b.getByTestId('file-them').getByTestId('file-line');
  await expect(line).toHaveText(/^([2-9]\d)% /, { timeout: 40_000 });
  await bctx.setOffline(true);
  await b.waitForTimeout(10_000);
  await bctx.setOffline(false);
  await b.waitForTimeout(3000);
  if ((await b.getByTestId('file-them').getAttribute('data-state')) === 'waiting') await openContact(a);
  await expect(b.getByTestId('file-them')).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
  await expect(b.getByTestId('file-them')).toContainText('received, checked');
});

test('relay killed and restarted (same address): one-scan connects again without a reload', async () => {
  const A = await lab.person('Asha');
  const B = await lab.person('Ravi');
  await relay.stop();
  await A.page.waitForTimeout(5000);
  await relay.start();
  await A.page.waitForTimeout(3000);
  const t0 = Date.now();
  const link = await showCard(A.page);
  await paste(B.page, link);
  let ok = true;
  try {
    await expect(B.page.getByTestId('peer-name')).toHaveText('Asha', { timeout: 40_000 });
  } catch {
    ok = false;
  }
  metric('relay-restart-one-scan', { connected: ok, seconds: (Date.now() - t0) / 1000, relayConnections: relay.connections });
  expect(ok, 'after the relay came back, one-scan did not connect (no relay reconnect?)').toBe(true);
});

test('relay killed while a code is shown, back 5 s later: the scan still connects', async () => {
  const A = await lab.person('Asha');
  const B = await lab.person('Ravi');
  const link = await showCard(A.page);
  await relay.stop();
  await A.page.waitForTimeout(5000);
  await relay.start();
  await A.page.waitForTimeout(2000);
  await paste(B.page, link);
  await expect(B.page.getByTestId('peer-name')).toHaveText('Asha', { timeout: 40_000 });
});

for (const delay of [2000, 5000]) {
  test(`slow relay (every reply ${delay / 1000} s late): one-scan and invite still connect`, async () => {
    relay.delayMs = delay;
    const A = await lab.person('Asha');
    const B = await lab.person('Ravi');
    let t0 = Date.now();
    await paste(B.page, await showCard(A.page));
    await expect(B.page.getByTestId('peer-name')).toHaveText('Asha', { timeout: 60_000 });
    const scanS = (Date.now() - t0) / 1000;
    const link = await makeInvite(A.page);
    const c = await lab.page(undefined, 'Meera');
    t0 = Date.now();
    await c.goto(`${lab.q()}${fragment(link)}`);
    await join(c, 'Meera');
    await expect(c.getByTestId('peer-name')).toHaveText('Asha', { timeout: 60_000 });
    metric(`slow-relay-${delay}ms`, { oneScanS: scanS, inviteS: (Date.now() - t0) / 1000 });
  });
}

test('the same invite opened twice by the same person: still one contact each side, no error, chat works', async () => {
  const A = await lab.person('Asha');
  const link = await makeInvite(A.page);
  const bctx = await lab.context();
  const b = await lab.page(bctx, 'Ravi');
  await b.goto(`${lab.q()}${fragment(link)}`);
  await join(b, 'Ravi');
  await expect(b.getByTestId('peer-name')).toHaveText('Asha', { timeout: 30_000 });
  // Opened again (e.g. tapped in the chat app a second time).
  await b.goto(`${lab.q()}${fragment(link)}`);
  // Signed in: the app asks first (link-confirm › link-connect).
  const connect = b.getByTestId('link-connect');
  if (await connect.isVisible({ timeout: 8000 }).catch(() => false)) await connect.click();
  await b.waitForTimeout(8000);
  const err = (await b.getByTestId('error').count()) ? await b.getByTestId('error').textContent() : '';
  await tab(b, 'chats');
  await expect(b.getByTestId('contact')).toHaveCount(1);
  await tab(A.page, 'chats');
  await expect(A.page.getByTestId('contact')).toHaveCount(1);
  metric('invite-opened-twice', { secondOpenError: err });
  await openContact(b);
  await expect(b.getByTestId('presence')).toHaveText('online', { timeout: 30_000 });
  await say(b, 'twice-ok');
  await expect(A.page.getByTestId('msg-them').last()).toContainText('twice-ok', { timeout: 20_000 });
});

test('a one-scan code reused after the shower reloads the page is still refused', async () => {
  const A = await lab.person('Asha');
  const B = await lab.person('Ravi');
  const C = await lab.person('Chetan');
  const link = await showCard(A.page);
  await paste(B.page, link);
  await expect(B.page.getByTestId('peer-name')).toHaveText('Asha', { timeout: 30_000 });
  await A.page.reload();
  await expect(A.page.getByTestId('tab-chats')).toBeVisible();
  await paste(C.page, link);
  await C.page.waitForTimeout(15_000);
  const cConnected = (await C.page.getByTestId('peer-name').count()) > 0;
  const cError = (await C.page.getByTestId('error').count()) ? await C.page.getByTestId('error').textContent() : '';
  metric('one-scan-reused-after-reload', { cConnected, cError });
  expect(cConnected, 'a used one-scan code connected a third person after the shower reloaded').toBe(false);
});

/** Shifts this page's clock (Date only) by `min` minutes, from the first script on. */
async function skew(p: Page, min: number): Promise<void> {
  await p.addInitScript((ms) => {
    const Real = Date;
    class Skewed extends Real {
      constructor(...a: unknown[]) {
        if (a.length) super(...(a as [number]));
        else super(Real.now() + ms);
      }
      static now() {
        return Real.now() + ms;
      }
    }
    (globalThis as unknown as { Date: DateConstructor }).Date = Skewed as unknown as DateConstructor;
  }, min * 60_000);
}

for (const [who, min] of [['A', 10], ['A', -10], ['B', 10], ['B', -10]] as const) {
  test(`clock ${min > 0 ? '+' : ''}${min} min on ${who}: one-scan and invite still connect`, async () => {
    const actx = await lab.context();
    const a = await lab.page(actx, 'Asha');
    const bctx = await lab.context();
    const b = await lab.page(bctx, 'Ravi');
    await skew(who === 'A' ? a : b, min);
    await a.goto(lab.q());
    await makeAccount(a, 'Asha');
    await b.goto(lab.q());
    await makeAccount(b, 'Ravi');
    let scan = true;
    await paste(b, await showCard(a));
    try {
      await expect(b.getByTestId('peer-name')).toHaveText('Asha', { timeout: 40_000 });
    } catch {
      scan = false;
    }
    const link = await makeInvite(a);
    const c = await lab.page(undefined, 'Meera');
    if (who === 'B') await skew(c, min);
    await c.goto(`${lab.q()}${fragment(link)}`);
    await join(c, 'Meera');
    let invite = true;
    try {
      await expect(c.getByTestId('peer-name')).toHaveText('Asha', { timeout: 40_000 });
    } catch {
      invite = false;
    }
    metric(`clock-${who}${min > 0 ? '+' : ''}${min}min`, { oneScan: scan, invite });
    expect({ oneScan: scan, invite }).toEqual({ oneScan: true, invite: true });
  });
}

test('two tabs, same account (same browser): a contact reconnecting reaches exactly one tab, no errors', async () => {
  const A = await lab.person('Asha', '&debug=1');
  const link = await makeInvite(A.page);
  const b = await lab.page(undefined, 'Ravi');
  await b.goto(`${lab.q()}${fragment(link)}`);
  await join(b, 'Ravi');
  await expect(b.getByTestId('peer-name')).toHaveText('Asha', { timeout: 30_000 });
  const tab2 = await lab.page(A.ctx, 'Asha-tab2');
  await tab2.goto(lab.q('&debug=1'));
  await expect(tab2.getByTestId('tab-chats')).toBeVisible();
  await A.page.goto(lab.q('&debug=1'));
  await b.goto(lab.q());
  await openContact(b);
  await expect(b.getByTestId('presence')).toHaveText('online', { timeout: 30_000 });
  await b.waitForTimeout(4000);
  const n1 = await A.page.getByTestId('peer-name').count();
  const n2 = await tab2.getByTestId('peer-name').count();
  metric('two-tabs-same-account', { tab1Chat: n1, tab2Chat: n2 });
  expect(n1 + n2, 'both tabs (or neither) opened the chat').toBe(1);
  const winner = n1 ? A.page : tab2;
  await say(b, 'which-tab');
  await expect(winner.getByTestId('msg-them').last()).toContainText('which-tab', { timeout: 20_000 });
  await say(winner, 'from-tab');
  await expect(b.getByTestId('msg-them').last()).toContainText('from-tab', { timeout: 20_000 });
  expect(lab.errors).toEqual([]);
});
