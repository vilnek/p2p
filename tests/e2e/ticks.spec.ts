import { expect, test, type Page } from '@playwright/test';
import { People, fragment, makeInvite } from './fixtures';
import { join, tab, doneWords } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// Message ticks (PROTOCOL §22): clock (waiting) · one grey (sent) · two grey (delivered) · two blue
// (read); read receipts off; a group's ticks and message info. LOCAL mock relay only.
// ?testHooks=1: __p2pTest.noReceipts(true) holds back receipts; __p2pTest.drop() closes every connection.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

const PHONE = { viewport: { width: 360, height: 740 }, hasTouch: true };
const hook = (p: Page, js: string) => p.evaluate(js);
const tickOf = (p: Page, text: string) => p.getByTestId('msg-me').filter({ hasText: text }).getByTestId('tick');

async function send(p: Page, text: string): Promise<void> {
  await p.getByTestId('message-input').fill(text);
  await p.getByTestId('send').click();
}

/** Dr Vijay (phone) and Ravi (computer, with test hooks), connected. */
async function pair(): Promise<{ a: Page; b: Page }> {
  const ctx = await people.context(PHONE);
  const a = await people.page(ctx, 'Dr Vijay');
  await a.goto(people.q('&testHooks=1'));
  await a.getByTestId('name').fill('Dr Vijay');
  await a.getByTestId('make-account').click();
  await doneWords(a);
  const link = await makeInvite(a);
  const b = await people.page(undefined, 'Ravi');
  await b.goto(`${people.q('&testHooks=1')}${fragment(link)}`);
  await join(b, 'Ravi');
  await expect(a.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 20_000 });
  await expect(b.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 20_000 });
  return { a, b };
}

/** Ravi leaves the chat (another screen in the main pane): his messages are delivered, not read. */
const away = async (b: Page) => {
  await tab(b, 'add');
  await b.getByTestId('show-my-code').click();
};

test('1:1 ticks: delivered, read, sent (no receipt), waiting while offline, then sent on reconnect; read receipts off', async () => {
  const { a, b: first } = await pair();
  let b = first;
  await away(b);
  await send(a, 'Namaste Ravi');
  await expect(tickOf(a, 'Namaste Ravi')).toHaveAttribute('data-st', 'd'); // his device has it
  // Ravi opens the chat: blue.
  await tab(b, 'chats');
  await b.getByTestId('contact').click();
  await expect(tickOf(a, 'Namaste Ravi')).toHaveAttribute('data-st', 'r');
  await away(b);
  await send(a, 'Photos tonight?');
  await expect(tickOf(a, 'Photos tonight?')).toHaveAttribute('data-st', 'd');
  // No receipt comes back: one grey tick (it left my device).
  await hook(b, '__p2pTest.noReceipts(true)');
  await send(a, 'Did you see them?');
  await expect(tickOf(a, 'Did you see them?')).toHaveAttribute('data-st', 'sent');
  await a.waitForTimeout(1500);
  await expect(tickOf(a, 'Did you see them?')).toHaveAttribute('data-st', 'sent');
  // The link goes down: a clock until it is back.
  // Ravi closes the app: a clock until he is back.
  const bctx = b.context();
  await b.close();
  await expect(a.getByTestId('presence')).not.toHaveText('online', { timeout: 20_000 });
  await send(a, 'Call me when you are back');
  await expect(tickOf(a, 'Call me when you are back')).toHaveAttribute('data-st', 'wait');
  await expect(a.getByTestId('tick')).toHaveCount(4);
  await a.waitForTimeout(300);
  await expect(tickOf(a, 'Call me when you are back')).toHaveAttribute('data-st', 'wait');
  await a.screenshot({ path: 'docs/screens/360-ticks.png' });
  // He opens the app again: the waiting message goes by itself and is delivered.
  b = await people.watch(await bctx.newPage(), 'Ravi again');
  await b.goto(people.q('&testHooks=1'));
  await expect(b.getByTestId('tab-chats')).toBeVisible();
  await a.getByTestId('try-connect').first().click({ timeout: 30_000 }).catch(() => undefined);
  // (Ravi's "Show my code" screen opens the chat when the link is back, so it may already be read.)
  await expect(tickOf(a, 'Call me when you are back')).toHaveAttribute('data-st', /^(d|r)$/, { timeout: 45_000 });
  await tab(b, 'chats');
  await b.getByTestId('contact').click();
  await expect(b.getByTestId('msg-them').last()).toHaveText(/Call me when you are back/);
  await expect(tickOf(a, 'Call me when you are back')).toHaveAttribute('data-st', 'r');

  // Ravi turns read receipts off: Dr Vijay's new message stays grey even when Ravi reads it.
  await away(b);
  await tab(b, 'me');
  await b.getByTestId('me-privacy').click();
  await b.getByTestId('read-receipts').uncheck();
  await send(a, 'Private reading');
  await expect(tickOf(a, 'Private reading')).toHaveAttribute('data-st', 'd');
  await tab(b, 'chats');
  await b.getByTestId('contact').click();
  await expect(b.getByTestId('msg-them').last()).toHaveText(/Private reading/);
  await a.waitForTimeout(1500);
  await expect(tickOf(a, 'Private reading')).toHaveAttribute('data-st', 'd');
  // And with his off, he doesn't see Dr Vijay's blue ticks either.
  await send(b, 'Got it');
  await a.waitForTimeout(500);
  await expect(b.getByTestId('msg-me').last().getByTestId('tick')).toHaveAttribute('data-st', 'd');
});

test('group ticks: two when every member has it, blue when every member read it; message info lists each member', async () => {
  const { a, b } = await pair();
  await a.getByTestId('chat-back').click();
  const link = await makeInvite(a);
  const c = await people.page(undefined, 'Asha');
  await c.goto(`${people.q()}${fragment(link)}`);
  await join(c, 'Asha');
  await expect(a.getByTestId('peer-name')).toHaveText('Asha', { timeout: 20_000 });
  await a.getByTestId('chat-back').click();
  await tab(a, 'groups');
  await a.getByTestId('groups-new').click();
  await a.getByTestId('group-name-input').fill('Seva team');
  for (const box of await a.getByTestId('group-pick').all()) await box.check();
  await a.getByTestId('group-create').click();
  for (const p of [b, c]) {
    await tab(p, 'groups');
    await p.getByTestId('group-join').click({ timeout: 20_000 });
    await expect(p.getByTestId('peer-name')).toHaveText('Seva team');
    await away(p);
  }
  await a.getByTestId('message-input').fill('Camp at 9');
  await a.getByTestId('send').click();
  const t = a.getByTestId('gmsg-me').last().getByTestId('tick');
  await expect(t).toHaveAttribute('data-st', 'd', { timeout: 30_000 });
  await tab(b, 'groups');
  await b.getByTestId('group').click();
  await a.waitForTimeout(1000);
  await expect(t).toHaveAttribute('data-st', 'd'); // only one of two has read it
  await tab(c, 'groups');
  await c.getByTestId('group').click();
  await expect(t).toHaveAttribute('data-st', 'r', { timeout: 20_000 });
  // Message info (hold, or right-click): each member read it.
  await a.getByTestId('gmsg-me').last().click({ button: 'right' });
  await expect(a.getByTestId('message-info').getByTestId('info-member')).toHaveCount(2);
  for (const row of await a.getByTestId('info-member').all()) await expect(row).toHaveAttribute('data-st', 'r');
});
