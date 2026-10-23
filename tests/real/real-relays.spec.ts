import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { CONNECTED, expectPeerId, join, makeAccount, myId, pathLabel, tab } from '../e2e/helpers';

// Uses the app's BUILT-IN public relays (no ?relays= override). Manual run only.
const contexts: BrowserContext[] = [];
test.afterEach(async () => { for (const c of contexts.splice(0)) await c.close(); });

const RELAYS = /^wss:\/\/(relay\.damus\.io|nos\.lol|relay\.primal\.net|offchain\.pub|nostr\.mom)\/?$/;
function guard(page: Page, seen: string[]): void {
  page.on('request', (r) => seen.push(r.url()));
  page.on('websocket', (ws) => seen.push(ws.url()));
}
function onlyAllowed(seen: string[]): void {
  const outside = seen.filter((u) => !/^http:\/\/127\.0\.0\.1:4318\/(p2p\.html([?#].*)?|favicon\.ico)$/.test(u) && !RELAYS.test(u) && !u.startsWith('blob:'));
  expect(outside).toEqual([]);
}
async function newPage(browser: Browser, seen: string[]): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(); contexts.push(ctx);
  const page = await ctx.newPage(); guard(page, seen);
  return { ctx, page };
}

test('REAL relays · one scan: connect, chat, video call', async ({ browser }) => {
  const seen: string[] = [];
  const A = await newPage(browser, seen); await A.page.goto('/p2p.html'); await makeAccount(A.page, 'Asha'); const aId = await myId(A.page);
  const B = await newPage(browser, seen); await B.page.goto('/p2p.html'); await makeAccount(B.page, 'Ravi'); const bId = await myId(B.page);
  await tab(A.page, 'add');
  await A.page.getByTestId('show-my-code').click();
  await expect(A.page.getByTestId('waiting-scan')).toBeVisible();
  await A.page.getByTestId('toggle-text').click();
  const link = await A.page.getByTestId('code-text').inputValue();
  console.log(`real-relay connect card: ${link.split('#c=')[1].length} characters`);
  const t0 = Date.now();
  await tab(B.page, 'add');
  await B.page.getByTestId('paste-their-code').click();
  await B.page.getByTestId('paste-box').fill(link);
  await B.page.getByTestId('paste-go').click();
  await expectPeerId(B.page, aId, 45_000);
  await expectPeerId(A.page, bId, 45_000);
  console.log(`one scan → connected through real relays in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await A.page.getByTestId('message-input').fill('Hello over the real relays');
  await A.page.getByTestId('send').click();
  await expect(B.page.getByTestId('msg-them')).toHaveText(/Hello over the real relays/);
  console.log('path:', await pathLabel(B.page));
  await B.page.getByTestId('video-call').click();
  await A.page.getByTestId('accept').click();
  await expect(B.page.getByTestId('call-status')).toHaveText(CONNECTED);
  await B.page.getByTestId('hang-up').click();
  onlyAllowed(seen);
});

test('REAL relays · invite while the sender is offline, then they connect', async ({ browser }) => {
  const seen: string[] = [];
  const A = await newPage(browser, seen); await A.page.goto('/p2p.html'); await makeAccount(A.page, 'Dr Vijay');
  await tab(A.page, 'add');
  await A.page.getByTestId('share-invite').click();
  await A.page.getByTestId('make-invite').click();
  const link = await A.page.getByTestId('invite-link').inputValue();
  await A.page.close(); // sender offline

  const B = await newPage(browser, seen);
  await B.page.goto(`/p2p.html#c=${link.split('#c=')[1]}`);
  await join(B.page, 'Ravi'); // instant join: one screen, Join
  await expect(B.page.getByTestId('invite-status')).toHaveText(/Request sent to Dr Vijay/, { timeout: 60_000 });
  console.log('invite: request stored on real relays while the sender was offline');

  const t0 = Date.now();
  const a = await A.ctx.newPage(); guard(a, seen);
  await a.goto('/p2p.html');
  // Ravi is still online: connect straight away, no Accept / Block.
  await expect(a.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 60_000 });
  console.log(`sender connected ${((Date.now() - t0) / 1000).toFixed(1)} s after coming back`);
  await expect(B.page.getByTestId('success-note')).toHaveText('Connected', { timeout: 60_000 });
  await a.getByTestId('message-input').fill('Welcome Ravi');
  await a.getByTestId('send').click();
  await expect(B.page.getByTestId('msg-them')).toHaveText(/Welcome Ravi/);
  onlyAllowed(seen);
});
