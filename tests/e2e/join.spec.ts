import { expect, test } from '@playwright/test';
import { People, fragment, makeInvite, showCard } from './fixtures';
import { join, tab, doneWords } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// Opening a link with no account: one screen ("Dr Vijay invited you"), a name, Join. The account is
// made at once and the join carries on with the same link (no second opening), even after a reload.
// The 24 words are offered afterwards. LOCAL mock relay only.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

test('invite link, no account: Join connects at once; the 24 words are offered afterwards', async () => {
  const A = await people.person('Dr Vijay');
  const link = await makeInvite(A.page);
  const b = await people.page(undefined, 'Ravi');
  await b.goto(`${people.q()}${fragment(link)}`);
  await expect(b.getByTestId('join-title')).toHaveText('Dr Vijay invited you');
  await expect(b.getByTestId('make-account')).toHaveCount(0);
  await join(b, 'Ravi');
  await expect(b.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 20_000 });
  await expect(b.getByTestId('success-note')).toHaveText('Connected');
  await expect(A.page.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 20_000 });
  await expect(b).toHaveURL(/\/p2p\.html\?relays=[^#]*$/);

  // The words come afterwards, gently: a banner in Chats (and Me).
  await tab(b, 'chats');
  await b.getByTestId('save-words-banner').click();
  await expect(b.getByTestId('words-cover')).toBeVisible(); // covered: hold to show
  await doneWords(b);
  await tab(b, 'me');
  await expect(b.getByTestId('save-words-banner')).toHaveCount(0);
  people.onlyLocal();
});

test('one-scan link, no account: Join connects with no second opening', async () => {
  const A = await people.person('Asha');
  const link = await showCard(A.page);
  const b = await people.page(undefined, 'Ravi');
  await b.goto(`${people.q()}${fragment(link)}`);
  await expect(b.getByTestId('join-title')).toHaveText('Connect on P2P Talk');
  await join(b, 'Ravi');
  await expect(b.getByTestId('peer-name')).toHaveText('Asha', { timeout: 20_000 });
  await expect(A.page.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 20_000 });
  people.onlyLocal();
});

for (const kind of ['one-scan', 'invite'] as const) {
  test(`${kind} link: a reload in the middle of joining carries on by itself`, async () => {
    const A = await people.person('Dr Vijay');
    const link = kind === 'invite' ? await makeInvite(A.page) : await showCard(A.page);
    const ctx = await people.context();
    const b = await people.page(ctx, 'Ravi');
    await b.goto(`${people.q()}${fragment(link)}`);
    await join(b, 'Ravi');
    await expect(b.getByTestId('tab-chats')).toBeAttached(); // the account exists, the join is under way
    await b.reload(); // no link in the address any more: it was kept for this tab
    await expect(b.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 30_000 });
    await expect(A.page.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 30_000 });
    // Done: a later reload doesn't join again.
    await b.reload();
    await expect(b.getByTestId('tab-chats')).toBeVisible();
    await expect(b.getByTestId('connecting')).toHaveCount(0);
    people.onlyLocal();
  });
}

test('join as guest: no 24 words, this browser only, connects', async () => {
  const A = await people.person('Dr Vijay');
  const link = await makeInvite(A.page);
  const b = await people.page(undefined, 'Guest');
  await b.goto(`${people.q()}${fragment(link)}`);
  await expect(b.getByTestId('guest-note')).toHaveText('Guest on this browser only. If you clear the browser, this account is gone.');
  await b.getByTestId('name').fill('Patient');
  await b.getByTestId('join-guest').click();
  await expect(b.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 20_000 });
  await expect(A.page.getByTestId('peer-name')).toHaveText('Patient', { timeout: 20_000 });
  await tab(b, 'me');
  await expect(b.getByTestId('guest-badge')).toContainText('Guest on this browser only');
  await expect(b.getByTestId('save-words-banner')).toHaveCount(0);
  await expect(b.getByTestId('phrase')).toHaveCount(0);
  people.onlyLocal();
});
