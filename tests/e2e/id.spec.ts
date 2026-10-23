import { expect, test, type Page } from '@playwright/test';
import { People, makeInvite } from './fixtures';
import { myId, tab } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// Copy / paste a P2P ID to connect (plain text, no link). Copying or sharing my ID makes me
// findable; the other side pastes it in any format, finds my card, sends a request; I accept once;
// then we chat. Plus Report and Delete my account and data. LOCAL mock relay only.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

const NOT_FOUND = 'Couldn’t find this ID. Ask them to open P2P Talk and share their ID again (it makes them findable).';

async function copyMyIdAndRead(a: Page): Promise<string> {
  await tab(a, 'me');
  await a.getByTestId('copy-my-id').click();
  await expect(a.getByTestId('findable-note')).toBeVisible();
  return a.evaluate(() => navigator.clipboard.readText());
}

async function lookUp(b: Page, text: string): Promise<void> {
  await tab(b, 'add');
  await b.getByTestId('type-id').click();
  await b.getByTestId('id-input').fill(text);
  await b.getByTestId('id-go').click();
}

test('copy my ID (findable turns on), paste it in several formats, request, accept once, chat', async () => {
  const A = await people.person('Dr Vijay');
  const B = await people.person('Ravi');
  const shown = await myId(A.page);
  const copied = await copyMyIdAndRead(A.page);
  expect(copied).toBe(shown.replace(/ /g, '')); // only the 24 digits
  await tab(A.page, 'me');
  await expect(A.page.getByTestId('share-my-id')).toBeVisible();

  // Bare digits, grouped, and the whole share message: all find the same card.
  for (const text of [copied, shown, `My P2P Talk ID: ${shown}`, shown.replace(/ /g, '-')]) {
    await lookUp(B.page, text);
    await expect(B.page.getByTestId('found-id')).toHaveText(shown, { timeout: 15_000 });
  }
  // The one-tap chip reads the clipboard only when tapped.
  await B.page.evaluate((t) => navigator.clipboard.writeText(t), `My P2P Talk ID: ${shown}`);
  await tab(B.page, 'add');
  await B.page.getByTestId('smart-paste').click();
  await expect(B.page.getByTestId('found-id')).toHaveText(shown, { timeout: 15_000 });
  await expect(B.page.getByTestId('found-name')).toHaveText('Found this ID'); // no name on the public card

  await B.page.getByTestId('send-request').click();
  await expect(B.page.getByTestId('id-status')).toHaveText('✓ Request sent. You’ll connect when they accept.', { timeout: 20_000 });
  await tab(A.page, 'chats');
  await expect(A.page.getByTestId('request-text')).toHaveText('Ravi wants to talk', { timeout: 20_000 });
  await A.page.getByTestId('accept-request').click();
  await expect(B.page.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 30_000 });
  await expect(A.page.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 30_000 });
  await A.page.getByTestId('message-input').fill('Found you by ID');
  await A.page.getByTestId('send').click();
  await expect(B.page.getByTestId('msg-them')).toHaveText(/Found you by ID/);
  people.onlyLocal();
});

test('a typo is refused by the check digit; not findable means "Couldn’t find"', async () => {
  const A = await people.person('Dr Vijay');
  const B = await people.person('Ravi');
  const shown = await myId(A.page);
  const digits = shown.replace(/ /g, '');
  const typo = digits.slice(0, 7) + ((Number(digits[7]) + 3) % 10) + digits.slice(8);
  await lookUp(B.page, typo);
  await expect(B.page.getByTestId('id-error')).toHaveText('This ID doesn’t look right. Check the 24 digits.');
  await lookUp(B.page, digits.slice(0, 20));
  await expect(B.page.getByTestId('id-error')).toHaveText('This ID doesn’t look right. Check the 24 digits.');

  // A never copied or shared the ID: not findable.
  await lookUp(B.page, shown);
  await expect(B.page.getByTestId('id-error')).toHaveText(NOT_FOUND, { timeout: 20_000 });

  // Findable on, then off again in Me › Privacy: the card is deleted and can't be found.
  await copyMyIdAndRead(A.page);
  await lookUp(B.page, shown);
  await expect(B.page.getByTestId('found-id')).toHaveText(shown, { timeout: 15_000 });
  await tab(A.page, 'me');
  await A.page.getByTestId('me-privacy').click();
  await expect(A.page.getByTestId('findable-toggle')).toBeChecked();
  await A.page.getByTestId('findable-toggle').click();
  await expect(A.page.getByTestId('findable-toggle')).not.toBeChecked();
  await expect.poll(() => relay.deleted.length, { timeout: 10_000 }).toBeGreaterThan(0);
  await lookUp(B.page, shown);
  await expect(B.page.getByTestId('id-error')).toHaveText(NOT_FOUND, { timeout: 20_000 });
});

test('Report a request: blocked, and my own email app gets the details', async () => {
  const A = await people.person('Dr Vijay');
  const B = await people.person('Spammer');
  const shown = await myId(A.page);
  await copyMyIdAndRead(A.page);
  const bId = (await myId(B.page)).replace(/ /g, '');
  await lookUp(B.page, shown);
  await B.page.getByTestId('send-request').click();
  await expect(B.page.getByTestId('id-status')).toBeVisible({ timeout: 20_000 });
  await tab(A.page, 'chats');
  await expect(A.page.getByTestId('request-text')).toHaveText('Spammer wants to talk', { timeout: 20_000 });
  A.page.once('dialog', (d) => void d.accept());
  await A.page.getByTestId('report-request').click();
  const sheet = A.page.getByTestId('report-sheet');
  await expect(sheet).toContainText('Blocked. You can also email us the details.');
  const href = await A.page.getByTestId('report-email').getAttribute('href');
  expect(href).toMatch(/^mailto:info@vilnek\.in\?subject=P2P%20Talk%20report&body=/);
  expect(decodeURIComponent(href!)).toContain(bId);
  await expect(A.page.getByTestId('request')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Close' }).click();
  // They try again: ignored.
  await lookUp(B.page, shown);
  await B.page.getByTestId('send-request').click();
  await expect(B.page.getByTestId('id-status')).toBeVisible({ timeout: 20_000 });
  await A.page.waitForTimeout(3000);
  await tab(A.page, 'chats');
  await expect(A.page.getByTestId('request')).toHaveCount(0);
});

test('Delete my account and data: relays are asked to delete my card and invite, then Welcome', async () => {
  const before = new Set(relay.stored().map((e) => e.id)); // other tests' events on this shared test relay
  const A = await people.person('Dr Vijay');
  await copyMyIdAndRead(A.page); // a public card on the relay
  await makeInvite(A.page);
  const fresh = () => relay.stored().filter((e) => !before.has(e.id));
  await expect.poll(() => fresh().length, { timeout: 10_000 }).toBeGreaterThan(0);
  const mine = fresh().map((e) => e.id);
  await tab(A.page, 'me');
  await A.page.getByTestId('delete-account').click();
  await expect(A.page.getByTestId('delete-sheet')).toContainText('Delete my account and data?');
  await A.page.getByTestId('delete-confirm').click();
  await expect(A.page.getByTestId('make-account')).toBeVisible({ timeout: 20_000 });
  await expect(A.page.getByTestId('terms')).toContainText('By continuing you agree to the Terms and the Privacy policy');
  for (const id of mine) expect(relay.deleted).toContain(id);
  // Nothing left on the device.
  await A.page.reload();
  await expect(A.page.getByTestId('make-account')).toBeVisible();
});
