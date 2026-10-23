import { expect, test, type Locator, type Page } from '@playwright/test';
import { People, fragment, makeInvite } from './fixtures';
import { doneWords, join, tab } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// Delete and remove options in the lists (design approved by Dr Vijay, 23 Oct 2026): hold a row
// (touch), right-click it (mouse) or press Shift+F10 on it for its options; swipe left on touch for the
// red button. Chats: Mute · Clear chat · Delete chat · Block. Groups: Mute · Clear chat · Leave group,
// then Delete group. Calls: Call again · Remove from list, and Clear all. Every destructive action asks
// once; everything happens on this device only. LOCAL mock relay only; demo names only.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const SHOTS = 'docs/screens';

/** Dr Vijay (on a phone) invites Meera Iyer; both end up in their chat. */
async function pair(): Promise<{ a: Page; b: Page }> {
  const ctx = await people.context(PHONE);
  const a = await people.page(ctx, 'Dr Vijay');
  await a.goto(people.q());
  await a.getByTestId('name').fill('Dr Vijay');
  await a.getByTestId('make-account').click();
  await doneWords(a);
  const link = await makeInvite(a);
  const b = await people.page(undefined, 'Meera');
  await b.goto(`${people.q()}${fragment(link)}`);
  await join(b, 'Meera Iyer');
  await expect(a.getByTestId('peer-name')).toHaveText('Meera Iyer', { timeout: 20_000 });
  await expect(b.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 20_000 });
  return { a, b };
}

/** How many messages one chat has in IndexedDB (sealed or not). */
function storedCount(p: Page, peer: string): Promise<number> {
  return p.evaluate(
    (peer) =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open('p2ptalk');
        req.onsuccess = () => {
          const all = req.result.transaction('messages', 'readonly').objectStore('messages').index('peer').count(peer);
          all.onsuccess = () => {
            resolve(all.result);
            req.result.close();
          };
          all.onerror = () => reject(all.error);
        };
        req.onerror = () => reject(req.error);
      }),
    peer,
  );
}

/** Every chat key with stored messages. */
function storedChats(p: Page): Promise<string[]> {
  return p.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const req = indexedDB.open('p2ptalk');
        req.onsuccess = () => {
          const all = req.result.transaction('messages', 'readonly').objectStore('messages').getAll();
          all.onsuccess = () => {
            resolve([...new Set(all.result.map((m: { peer: string }) => m.peer))]);
            req.result.close();
          };
          all.onerror = () => reject(all.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
}

/** Where a row is now (the list redraws often, e.g. when someone comes online). */
async function boxOf(row: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  for (let i = 0; i < 50; i++) {
    const b = await row.boundingBox().catch(() => null);
    if (b) return b;
    await row.page().waitForTimeout(100);
  }
  throw new Error('row not visible');
}

/** Touch: hold a row until its options open. */
async function hold(row: Locator): Promise<void> {
  const box = await boxOf(row);
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, pointerType: 'touch', pointerId: 7, isPrimary: true, button: 0, bubbles: true };
  await row.dispatchEvent('pointerdown', at);
  await row.page().waitForTimeout(650);
  await row.dispatchEvent('pointerup', at);
}

/** Touch: swipe a row to the left (shows its red button), on one element from start to end. */
async function swipeLeft(row: Locator): Promise<void> {
  await boxOf(row);
  await row.evaluate(async (el) => {
    const b = el.getBoundingClientRect();
    const y = b.top + b.height / 2;
    const x0 = b.right - 30;
    const ev = (type: string, x: number) => el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerType: 'touch', pointerId: 9, isPrimary: true, button: 0, bubbles: true }));
    ev('pointerdown', x0);
    for (let i = 1; i <= 8; i++) {
      ev('pointermove', x0 - i * 20);
      await new Promise((r) => setTimeout(r, 16));
    }
    ev('pointerup', x0 - 160);
  });
  await row.page().waitForTimeout(300); // the row settles
}

async function phoneBack(p: Page): Promise<void> {
  if (await p.getByTestId('chat-back').isVisible()) await p.getByTestId('chat-back').click();
}

/** After a reload the contact reconnects and their chat opens by itself: wait for that, then back to the list. */
async function reloadAndSettle(p: Page): Promise<void> {
  await p.reload();
  await expect(p.getByTestId('peer-name')).toBeVisible({ timeout: 25_000 });
  await expect(p.getByTestId('presence')).toHaveText(/^online$/, { timeout: 25_000 });
  await phoneBack(p);
  await tab(p, 'chats');
}

test('Chats: hold or right-click for options; Mute stays after reload; Clear chat; swipe; Delete chat; a deleted contact who reconnects is a request', async () => {
  const { a, b } = await pair();
  await a.getByTestId('message-input').fill('Hello Meera');
  await a.getByTestId('send').click();
  await expect(b.getByTestId('msg-them')).toHaveText(/Hello Meera/);
  await b.getByTestId('message-input').fill('Namaste Dr Vijay');
  await b.getByTestId('send').click();
  await expect(a.getByTestId('msg-them')).toHaveText(/Namaste Dr Vijay/);
  await phoneBack(a);
  await tab(a, 'chats');
  const row = a.getByTestId('contact').filter({ hasText: 'Meera Iyer' });
  await expect(row).toHaveCount(1);

  // Hold (touch): the options sheet; nothing else opens.
  await hold(row);
  const menu = a.getByTestId('chat-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.menu-item .k')).toHaveText(['Mute', 'Clear chat', 'Delete chat', 'Block']);
  await expect(a.getByTestId('messages')).toHaveCount(0); // the hold did not open the chat
  await a.screenshot({ path: `${SHOTS}/delete-chat-menu.png` });

  // Mute: a small bell-off on the row, kept after a reload.
  await a.getByTestId('menu-mute').click();
  await expect(row.getByTestId('muted-icon')).toBeVisible();
  await reloadAndSettle(a);
  await expect(row.getByTestId('muted-icon')).toBeVisible({ timeout: 20_000 });
  // Right-click opens the same options; Unmute.
  await row.click({ button: 'right' });
  await expect(a.getByTestId('menu-mute')).toHaveText('Unmute');
  await a.getByTestId('menu-mute').click();
  await expect(row.getByTestId('muted-icon')).toHaveCount(0);

  // Keyboard: Shift+F10 on the focused row.
  await row.focus();
  await a.keyboard.press('Shift+F10');
  await expect(a.getByTestId('chat-menu')).toBeVisible();

  // Clear chat: asks once (red button); the messages go, Meera stays.
  await a.getByTestId('menu-clear').click();
  const confirm = a.getByTestId('confirm-sheet');
  await expect(confirm.locator('h2')).toHaveText('Clear chat with Meera Iyer?');
  await expect(confirm.getByTestId('confirm-yes')).toHaveText('Clear chat');
  await expect(confirm.getByTestId('confirm-yes')).toHaveClass(/dang-fill/);
  await a.screenshot({ path: `${SHOTS}/delete-clear-confirm.png` });
  const chatKey = await a.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const req = indexedDB.open('p2ptalk');
        req.onsuccess = () => {
          const all = req.result.transaction('contacts', 'readonly').objectStore('contacts').getAll();
          all.onsuccess = () => resolve((all.result[0] as { id: string }).id);
        };
      }),
  );
  expect(await storedCount(a, chatKey)).toBe(2);
  await confirm.getByTestId('confirm-yes').click();
  await expect(confirm).toHaveCount(0);
  await expect.poll(() => storedCount(a, chatKey)).toBe(0);
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('chat-preview')).not.toContainText('Namaste');
  await reloadAndSettle(a);
  await expect(row).toHaveCount(1);
  expect(await storedCount(a, chatKey)).toBe(0);

  // Swipe left (touch): the red Delete chat button; it asks first (Cancel keeps everything).
  await swipeLeft(row);
  const swipeBtn = a.getByTestId('swipe-delete');
  await expect(swipeBtn).toBeVisible();
  await expect(swipeBtn).toHaveText('Delete chat');
  await a.screenshot({ path: `${SHOTS}/delete-swipe.png` });
  await swipeBtn.click();
  await expect(a.getByTestId('confirm-sheet').locator('h2')).toHaveText('Delete chat with Meera Iyer?');
  await a.getByTestId('confirm-cancel').click();
  await expect(row).toHaveCount(1);

  // Delete chat (from the options): the person, the messages and their files go from this device.
  await b.getByTestId('message-input').fill('One more before');
  await b.getByTestId('send').click();
  await expect.poll(() => storedCount(a, chatKey), { timeout: 20_000 }).toBe(1);
  await hold(row);
  await a.getByTestId('menu-delete').click();
  await expect(a.getByTestId('confirm-sheet').locator('p.muted')).toHaveText('This removes the chat and its messages from this device. Meera can add you again.');
  await a.screenshot({ path: `${SHOTS}/delete-chat-confirm.png` });
  await a.getByTestId('confirm-yes').click();
  await expect(a.getByTestId('contact')).toHaveCount(0);
  expect(await storedCount(a, chatKey)).toBe(0);
  await a.reload();
  await expect(a.getByTestId('tab-chats')).toBeVisible();
  await a.waitForTimeout(1500);
  await expect(a.getByTestId('contact')).toHaveCount(0);
  expect(await storedChats(a)).toEqual([]);

  // Meera still has Dr Vijay: her message waits, and her reconnect shows on Dr Vijay's phone as a
  // request ("wants to talk again"), never taken back by itself.
  await b.getByTestId('message-input').fill('Are you there?');
  await b.getByTestId('send').click();
  await expect(b.getByTestId('msg-me').filter({ hasText: 'Are you there?' }).getByTestId('tick')).toHaveAttribute('data-st', /wait|sent/); // stored before the reload
  await b.reload(); // opens the chat again: she tries to reconnect
  await b.getByTestId('contact').filter({ hasText: 'Dr Vijay' }).click();
  await expect(a.getByTestId('again-request')).toBeVisible({ timeout: 40_000 });
  await expect(a.getByTestId('again-request').getByTestId('request-text')).toHaveText('Meera Iyer wants to talk again');
  await expect(a.getByTestId('contact')).toHaveCount(0);
  expect(await storedChats(a)).toEqual([]);
  await a.screenshot({ path: `${SHOTS}/delete-again-request.png` });

  // Accept: a new chat (the old messages stay deleted); her waiting message arrives.
  await a.getByTestId('accept-again').click();
  await expect(a.getByTestId('contact').filter({ hasText: 'Meera Iyer' })).toHaveCount(1, { timeout: 30_000 });
  // They connect again: the new chat opens by itself (nothing else is on screen).
  await expect(a.getByTestId('peer-name')).toHaveText('Meera Iyer', { timeout: 40_000 });
  await expect(a.getByTestId('msg-them').filter({ hasText: 'Are you there?' })).toHaveCount(1, { timeout: 40_000 });
  await expect(a.getByTestId('msg-them').filter({ hasText: 'Namaste' })).toHaveCount(0);
  await expect(a.getByTestId('msg-me')).toHaveCount(0);
  people.onlyLocal();
});

test('Groups: Leave group by swiping, then Delete group (only after leaving); gone after a reload', async () => {
  const { a, b } = await pair();
  await phoneBack(a);
  await tab(a, 'add');
  await a.getByTestId('new-group').click();
  await a.getByTestId('group-name-input').fill('Seva team');
  for (const box of await a.getByTestId('group-pick').all()) await box.check();
  await a.getByTestId('group-create').click();
  await expect(a.getByTestId('group-count')).toHaveText('2 members');
  await tab(b, 'groups');
  await b.getByTestId('group-join').click({ timeout: 20_000 });
  await expect(b.getByTestId('peer-name')).toHaveText('Seva team');
  await b.getByTestId('message-input').fill('Welcome to Seva team');
  await b.getByTestId('send').click();
  await expect(a.getByTestId('gmsg-them').filter({ hasText: 'Welcome' })).toHaveCount(1, { timeout: 20_000 });
  await phoneBack(a);
  await tab(a, 'groups');
  const row = a.getByTestId('group').filter({ hasText: 'Seva team' });

  // While in the group: Mute · Clear chat · Leave group (no Delete group yet).
  await hold(row);
  await expect(a.getByTestId('group-menu').locator('.menu-item .k')).toHaveText(['Mute', 'Clear chat', 'Leave group']);
  await a.screenshot({ path: `${SHOTS}/delete-group-menu.png` });
  await a.getByTestId('menu-cancel').click();

  // Swipe left: Leave group (asks first).
  await swipeLeft(row);
  await expect(a.getByTestId('swipe-leave')).toHaveText('Leave group');
  await a.getByTestId('swipe-leave').click();
  await expect(a.getByTestId('confirm-sheet').locator('h2')).toHaveText('Leave Seva team?');
  await a.getByTestId('confirm-yes').click();
  await expect(row.getByTestId('chat-preview')).toHaveText('You left', { timeout: 15_000 });
  await expect(b.getByTestId('group-count')).toHaveText('1 members', { timeout: 20_000 });
  const gid = await row.evaluate(() => document.querySelector('[data-testid=group] [data-av]')?.getAttribute('data-av') ?? '');
  expect(await storedCount(a, `g:${gid}`)).toBeGreaterThan(0);

  // Now Delete group is offered (and Leave is not).
  await row.click({ button: 'right' });
  await expect(a.getByTestId('group-menu').locator('.menu-item .k')).toHaveText(['Mute', 'Clear chat', 'Delete group']);
  await a.getByTestId('menu-delete-group').click();
  await expect(a.getByTestId('confirm-sheet').locator('h2')).toHaveText('Delete Seva team?');
  await a.screenshot({ path: `${SHOTS}/delete-group-confirm.png` });
  await a.getByTestId('confirm-yes').click();
  await expect(a.getByTestId('group')).toHaveCount(0);
  expect(await storedCount(a, `g:${gid}`)).toBe(0);
  await a.reload();
  await tab(a, 'groups');
  await expect(a.getByTestId('groups-empty')).toBeVisible({ timeout: 20_000 });
  await expect(a.getByTestId('group')).toHaveCount(0);
  people.onlyLocal();
});

test('Calls: a call ends by itself back in the chat (no OK); Remove from list; Clear all; kept after a reload', async () => {
  const { a, b } = await pair();
  // Declined: Dr Vijay's call screen closes by itself and the chat says so, with Call again.
  await a.getByTestId('voice-call').click();
  await b.getByTestId('decline').click({ timeout: 20_000 });
  await expect(a.getByTestId('call-screen')).toHaveCount(0, { timeout: 10_000 });
  await expect(b.getByTestId('call-screen')).toHaveCount(0, { timeout: 10_000 });
  await expect(a.getByTestId('call-end-note')).toContainText('Voice call · Meera Iyer declined');
  await expect(a.getByTestId('call-again')).toBeVisible();
  await expect(a.getByTestId('peer-name')).toHaveText('Meera Iyer');

  // Talked, then hung up: both screens close by themselves; nothing to press.
  await a.getByTestId('voice-call').click();
  await b.getByTestId('accept').click({ timeout: 20_000 });
  await expect(a.getByTestId('call-status')).toHaveText(/^\d\d:\d\d$/, { timeout: 25_000 });
  await a.getByTestId('hang-up').click();
  for (const p of [a, b]) {
    await expect(p.getByTestId('call-screen')).toHaveCount(0, { timeout: 10_000 });
    await expect(p.getByTestId('call-end-note').last()).toContainText(/Voice call · \d+ min/);
    await expect(p.getByRole('button', { name: 'OK' })).toHaveCount(0);
  }

  await phoneBack(a);
  await tab(a, 'calls');
  const rows = a.getByTestId('call-row');
  await expect(rows).toHaveCount(2);
  await hold(rows.first());
  await expect(a.getByTestId('call-menu').locator('.menu-item .k')).toHaveText(['Call again', 'Remove from list']);
  await a.screenshot({ path: `${SHOTS}/delete-call-menu.png` });
  await a.getByTestId('menu-remove').click();
  await expect(a.getByTestId('confirm-sheet').locator('h2')).toHaveText('Remove this call from the list?');
  await a.getByTestId('confirm-yes').click();
  await expect(rows).toHaveCount(1);
  // Swipe: Remove.
  await swipeLeft(rows.first());
  await expect(a.getByTestId('swipe-remove')).toBeVisible();
  await a.mouse.click(10, 10); // closes the swiped row
  await reloadAndSettle(a);
  await tab(a, 'calls');
  await expect(rows).toHaveCount(1, { timeout: 20_000 });
  // Clear all.
  await a.getByTestId('calls-clear').click();
  await expect(a.getByTestId('confirm-sheet').locator('h2')).toHaveText('Clear all calls?');
  await a.getByTestId('confirm-yes').click();
  await expect(rows).toHaveCount(0);
  await expect(a.getByText('No calls yet')).toBeVisible();
  await reloadAndSettle(a);
  await tab(a, 'calls');
  await expect(a.getByText('No calls yet')).toBeVisible({ timeout: 20_000 });
  await expect(a.getByTestId('calls-clear')).toHaveCount(0);
  people.onlyLocal();
});
