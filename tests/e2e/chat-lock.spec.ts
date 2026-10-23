import { expect, test, type Page } from '@playwright/test';
import { People, fragment, makeInvite } from './fixtures';
import { join, openInfo, tab, doneWords } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// Chat lock (plan §8.7): lock a chat or a group with a secret code; locked chats leave the Chats list,
// their messages are stored sealed, new ones show only "New message", wrong codes wait, and they lock
// again when the person leaves them. LOCAL mock relay only.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

/** Dr Vijay (on a phone) invites Ravi; both end up in their chat. */
async function pair(): Promise<{ a: Page; b: Page }> {
  const ctx = await people.context(PHONE);
  const a = await people.page(ctx, 'Dr Vijay');
  await a.goto(people.q());
  await a.getByTestId('name').fill('Dr Vijay');
  await a.getByTestId('make-account').click();
  await doneWords(a);
  const link = await makeInvite(a);
  const b = await people.page(undefined, 'Ravi');
  await b.goto(`${people.q()}${fragment(link)}`);
  await join(b, 'Ravi');
  await expect(a.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 20_000 });
  await expect(b.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 20_000 });
  return { a, b };
}

/** Every stored message of one chat, as IndexedDB holds it (text, and whether it is sealed). */
async function stored(p: Page, peer: string): Promise<{ text: string; locked: boolean; file: boolean }[]> {
  return p.evaluate(
    (peer) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('p2ptalk');
        req.onsuccess = () => {
          const tx = req.result.transaction('messages', 'readonly');
          const all = tx.objectStore('messages').index('peer').getAll(peer);
          all.onsuccess = () => {
            resolve(all.result.map((m: { text: string; locked?: unknown; file?: unknown }) => ({ text: m.text, locked: !!m.locked, file: !!m.file })));
            req.result.close();
          };
          all.onerror = () => reject(all.error);
        };
        req.onerror = () => reject(req.error);
      }),
    peer,
  );
}

async function setCodeAndLock(a: Page, code: string): Promise<void> {
  await expect(a.getByTestId('set-code-sheet')).toBeVisible();
  await a.getByTestId('code-new').fill('12');
  await a.getByTestId('code-again').fill('12');
  await a.getByTestId('code-set').click();
  await expect(a.getByTestId('set-code-sheet').getByTestId('error')).toHaveText('Use at least 4 digits.');
  await a.getByTestId('code-new').fill(code);
  await a.getByTestId('code-again').fill(code + '0');
  await a.getByTestId('code-set').click();
  await expect(a.getByTestId('set-code-sheet').getByTestId('error')).toHaveText('The two codes are not the same.');
  await a.getByTestId('code-again').fill(code);
  await a.getByTestId('code-set').click();
}

async function enterCode(a: Page, code: string): Promise<void> {
  await expect(a.getByTestId('code-sheet')).toBeVisible();
  await a.getByTestId('code-input').fill(code);
  await a.getByTestId('code-go').click();
}

test('lock a chat: it hides, new messages say only "New message", stored sealed, wrong code waits, opens with the code, locks again on leaving', async () => {
  const { a, b } = await pair();
  await a.getByTestId('message-input').fill('Before the lock');
  await a.getByTestId('send').click();
  await expect(b.getByTestId('msg-them')).toHaveText(/Before the lock/);

  // Lock it from the details (the first time sets the code).
  const info = await openInfo(a);
  await info.getByTestId('lock-chat').click();
  await setCodeAndLock(a, '2580');
  await expect(a.getByTestId('toast')).toContainText('Chat locked');
  await tab(a, 'chats');
  await expect(a.getByTestId('contact')).toHaveCount(0);
  await expect(a.getByTestId('locked-chats')).toBeVisible();

  // What is stored for this chat is sealed: no text, no file names.
  const contactId = await a.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const r = indexedDB.open('p2ptalk');
        r.onsuccess = () => {
          const g = r.result.transaction('contacts').objectStore('contacts').getAll();
          g.onsuccess = () => resolve((g.result as { id: string }[])[0].id);
        };
      }),
  );
  let rows = await stored(a, contactId);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((m) => m.locked && m.text === '')).toBe(true);

  // A new message from Ravi: a toast with no name and no text; the Locked chats row counts it.
  await b.getByTestId('message-input').fill('Secret plan for Diwali');
  await b.getByTestId('send').click();
  await expect(a.getByTestId('toast')).toHaveText('New message');
  await expect(a.getByTestId('locked-unread')).toHaveText('1');
  await expect(a.locator('body')).not.toContainText('Secret plan');
  rows = await stored(a, contactId);
  expect(rows.every((m) => m.locked && m.text === '')).toBe(true);

  // Wrong code: a short wait before the next try.
  await a.getByTestId('locked-chats').click();
  await enterCode(a, '1111');
  await expect(a.getByTestId('code-sheet').getByTestId('error')).toHaveText(/Wrong code\. Try again in 1 s\./);
  await expect(a.getByTestId('code-go')).toBeDisabled();
  await expect(a.getByTestId('code-go')).toBeEnabled({ timeout: 5000 });
  await enterCode(a, '2580');
  await expect(a.getByTestId('locked-list').getByTestId('contact-name')).toHaveText('Ravi');
  await a.getByTestId('locked-list').getByTestId('contact').click();
  await expect(a.getByTestId('msg-them')).toHaveText(/Secret plan for Diwali/);
  await expect(a.getByTestId('msg-me')).toHaveText(/Before the lock/);

  // Back goes to the Locked chats list (still open); leaving it locks again.
  await a.getByTestId('chat-back').click();
  await expect(a.getByTestId('locked-list')).toBeVisible();
  await a.getByTestId('back').click();
  await expect(a.getByTestId('contact')).toHaveCount(0);
  await a.getByTestId('locked-chats').click();
  await expect(a.getByTestId('code-sheet')).toBeVisible();
  await a.keyboard.press('Escape');

  // Me › Chat lock shows it is on; Privacy offers Change secret code.
  await tab(a, 'me');
  await expect(a.getByTestId('me-chat-lock')).toContainText('On · 1 chat');
  await expect(a.getByTestId('me-notifications')).toHaveCount(0);
  await expect(a.locator('body')).not.toContainText('Coming soon');
  people.onlyLocal();
});

test('change code re-seals; "forgot code" removes the lock and deletes only the locked messages here', async () => {
  const { a, b } = await pair();
  await b.getByTestId('message-input').fill('Hello from Ravi');
  await b.getByTestId('send').click();
  await expect(a.getByTestId('msg-them')).toHaveText(/Hello from Ravi/);
  const info = await openInfo(a);
  await info.getByTestId('lock-chat').click();
  await setCodeAndLock(a, '2580');
  await tab(a, 'chats');
  await expect(a.getByTestId('locked-chats')).toBeVisible();

  await tab(a, 'me');
  await a.getByTestId('me-privacy').click();
  await a.getByTestId('change-code').click();
  await a.getByTestId('code-old').fill('2580');
  await a.getByTestId('code-new').fill('seva 2040');
  await a.getByTestId('code-again').fill('seva 2040');
  await a.getByTestId('code-change').click();
  await expect(a.getByTestId('toast')).toHaveText('Secret code changed');

  await a.getByTestId('back').click();
  await tab(a, 'chats');
  await a.getByTestId('locked-chats').click();
  await enterCode(a, '2580');
  await expect(a.getByTestId('code-sheet').getByTestId('error')).toContainText('Wrong code');
  await expect(a.getByTestId('code-go')).toBeEnabled({ timeout: 5000 });
  await enterCode(a, 'seva 2040');
  await a.getByTestId('locked-list').getByTestId('contact').click();
  await expect(a.getByTestId('msg-them')).toHaveText(/Hello from Ravi/);
  await a.getByTestId('chat-back').click();
  await a.getByTestId('back').click();

  // Forgot: remove the lock; the chat comes back, empty on this device.
  await a.getByTestId('locked-chats').click();
  await a.getByTestId('forgot-code').click();
  await a.getByTestId('forgot-confirm').click();
  await expect(a.getByTestId('locked-chats')).toHaveCount(0);
  await expect(a.getByTestId('contact-name')).toHaveText('Ravi');
  await a.getByTestId('contact').click();
  await expect(a.getByTestId('peer-name')).toHaveText('Ravi');
  await expect(a.getByTestId('msg-them')).toHaveCount(0);
  await expect(b.getByTestId('msg-them')).toHaveCount(0); // Ravi's side is untouched (he wrote, never received)
  await expect(b.getByTestId('msg-me')).toHaveText(/Hello from Ravi/);
});

test('lock a group: it shows as "Locked" in Groups (no preview), its messages say only "New message", it opens with the code', async () => {
  const { a, b } = await pair();
  await a.getByTestId('chat-back').click();
  await tab(a, 'groups');
  await expect(a.getByTestId('groups-empty')).toContainText('Start your first group');
  await a.getByTestId('groups-new').click();
  await a.getByTestId('group-name-input').fill('Seva team');
  for (const box of await a.getByTestId('group-pick').all()) await box.check();
  await a.getByTestId('group-create').click();
  await expect(a.getByTestId('peer-name')).toHaveText('Seva team');
  await expect(a.getByTestId('attach')).toBeVisible(); // files to a group (sent to each member online)
  await tab(b, 'groups'); // Ravi is on a wide screen: the tabs are always there
  await b.getByTestId('group-join').click({ timeout: 20_000 });
  await expect(b.getByTestId('peer-name')).toHaveText('Seva team');

  await a.getByTestId('group-info-open').click();
  await a.getByTestId('lock-chat').click();
  await setCodeAndLock(a, '2580');
  await tab(a, 'groups');
  const row = a.getByTestId('group');
  await expect(row).toHaveAttribute('data-locked', '1');
  await expect(row.getByTestId('chat-preview')).toHaveText('Locked');
  await tab(a, 'chats');
  await expect(a.getByTestId('locked-chats')).toHaveCount(0); // that row is for 1:1 chats only
  await expect(a.getByTestId('group')).toHaveCount(0); // Chats has 1:1 chats only

  await b.getByTestId('message-input').fill('Group secret');
  await b.getByTestId('send').click();
  await expect(a.getByTestId('toast')).toHaveText('New message', { timeout: 20_000 });
  await expect(a.locator('body')).not.toContainText('Group secret');
  await expect(a.getByTestId('tab-groups-unread')).toHaveText('1');

  await tab(a, 'groups');
  await expect(a.getByTestId('group').getByTestId('chat-preview')).toHaveText('Locked');
  await a.getByTestId('group').click();
  await enterCode(a, '2580');
  await expect(a.getByTestId('gmsg-them').last()).toContainText('Group secret');
  // Remove the lock: back in Groups with its preview.
  await a.getByTestId('group-info-open').click();
  await a.getByTestId('unlock-chat').click();
  await expect(a.getByTestId('toast')).toContainText('Chat lock removed');
  await a.getByTestId('chat-back').click();
  await expect(a.getByTestId('group-name')).toHaveText('Seva team');
  await expect(a.getByTestId('chat-preview').first()).toContainText('Group secret');
});
