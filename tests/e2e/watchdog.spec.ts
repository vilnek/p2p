import { expect, test, type Page } from '@playwright/test';
import { People, showCard } from './fixtures';
import { tab, doneWords } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// A direct connection that never opens: one automatic retry, then one plain sentence with Try again,
// Back and Connection details. Never "Connecting…" again and again. Test switches: ?breakIce=1 leaves
// the network addresses out of both codes, ?connectWait=3000 waits 3 s instead of 20 s.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

const GENERAL = 'Can’t connect directly. If you’re on the same Wi-Fi, allow P2P Talk to use the local network in Settings, then try again.';
const IOS = 'Can’t connect on this Wi-Fi. Allow P2P Talk to use the local network: Settings › Privacy & Security › Local Network › P2P Talk.';
const BROKEN = '&breakIce=1&connectWait=3000';

async function countConnecting(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __connecting: number };
    w.__connecting = 0;
    let was = false;
    new MutationObserver(() => {
      const is = !!document.querySelector('[data-testid=connecting]');
      if (is && !was) w.__connecting++;
      was = is;
    }).observe(document.body, { subtree: true, childList: true });
  });
}

test('no direct path: one retry, then one plain sentence, Try again, Back and Connection details', async () => {
  const A = await people.person('Asha', BROKEN);
  const B = await people.person('Ravi', BROKEN);
  const link = await showCard(A.page);
  await countConnecting(B.page);
  await tab(B.page, 'add');
  await B.page.getByTestId('paste-their-code').click();
  await B.page.getByTestId('paste-box').fill(link);
  await B.page.getByTestId('paste-go').click();
  await expect(B.page.getByTestId('fail-text')).toHaveText(GENERAL, { timeout: 30_000 });
  await expect(B.page.getByTestId('try-again-connect')).toBeVisible();
  expect(await B.page.evaluate(() => (window as unknown as { __connecting: number }).__connecting)).toBe(1);
  // Two attempts reached A (the automatic retry), and A also stops and says so.
  await expect(A.page.getByTestId('fail-text')).toHaveText(GENERAL, { timeout: 30_000 });

  await B.page.getByTestId('open-details').click();
  const details = B.page.getByTestId('conn-details');
  await expect(details).toContainText('Attempt: One-scan code (I scanned theirs) · failed');
  await expect(details).toContainText('Relays connected: 127.0.0.1');
  await expect(details).toContainText('iceGatheringState complete');
  await expect(details).toContainText('Last error: not connected after 3 s');
  await expect(details).toContainText(/Local candidates: [1-9]/);
  const text = (await details.textContent())!.split('\n').filter((l) => !l.startsWith('Running in:') && !l.startsWith('Relays connected:')).join('\n');
  expect(text).not.toMatch(/\b\d+\.\d+\.\d+\.\d+\b/); // no full device addresses (relay names and the browser version aside)
  people.onlyLocal();
});

test('inside the iPhone app, a same-network failure names the Local Network setting', async () => {
  const A = await people.person('Asha', BROKEN);
  const ctx = await people.context();
  await ctx.addInitScript(() => {
    (window as unknown as { Capacitor: object }).Capacitor = { getPlatform: () => 'ios' };
  });
  const b = await people.page(ctx, 'Ravi');
  await b.goto(people.q(BROKEN));
  await b.getByTestId('name').fill('Ravi');
  await b.getByTestId('make-account').click();
  await doneWords(b);
  const link = await showCard(A.page);
  await tab(b, 'add');
  await b.getByTestId('paste-their-code').click();
  await b.getByTestId('paste-box').fill(link);
  await b.getByTestId('paste-go').click();
  await expect(b.getByTestId('fail-text')).toHaveText(IOS, { timeout: 30_000 });
});
