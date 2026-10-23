import { expect, test, type Page } from '@playwright/test';
import { People, fragment, makeInvite } from './fixtures';
import { closeInfo, join, myId, openInfo, tab, doneWords } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// Play Store must-haves (chat apps): Report from a chat and from a group (a member), and the Terms /
// Privacy links. Report-a-request and Delete my account and data are in id.spec.ts.
// LOCAL mock relay only.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

/** Dr Vijay and Ravi, connected through an invite. */
async function pair(): Promise<{ a: Page; b: Page }> {
  const A = await people.person('Dr Vijay');
  const link = await makeInvite(A.page);
  const b = await people.page(undefined, 'Ravi');
  await b.goto(`${people.q()}${fragment(link)}`);
  await join(b, 'Ravi');
  await expect(A.page.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 20_000 });
  await expect(b.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 20_000 });
  return { a: A.page, b };
}

/** The report email's body, as the mail app would read it. */
async function reportBody(p: Page): Promise<string> {
  const href = (await p.getByTestId('report-email').getAttribute('href'))!;
  expect(href).toMatch(/^mailto:info@vilnek\.in\?subject=P2P%20Talk%20report&body=[^&]+$/);
  return decodeURIComponent(href.split('&body=')[1]);
}

test('Report from a chat: blocked, gone from Chats, and the email has both IDs and the date', async () => {
  const { a, b } = await pair();
  const aId = (await myId(a)).replace(/ /g, '');
  await tab(b, 'chats');
  const bId = (await myId(b)).replace(/ /g, '');
  await tab(a, 'chats');
  await a.getByTestId('contact').first().click();
  const info = await openInfo(a);
  a.once('dialog', (d) => void d.accept());
  await info.getByTestId('report-contact').click();
  const sheet = a.getByTestId('report-sheet');
  await expect(sheet).toContainText('Blocked. You can also email us the details.');
  const body = await reportBody(a);
  expect(body).toContain(`Their P2P ID: ${bId}`);
  expect(body).toContain('Their name: Ravi');
  expect(body).toContain(`My P2P ID: ${aId}`);
  expect(body).toMatch(/Date: \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  await sheet.getByRole('button', { name: 'Close' }).click();
  await closeInfo(a);
  // Blocked: no longer a contact, and their next message does not reach me.
  await tab(a, 'chats');
  await expect(a.getByTestId('contact')).toHaveCount(0);
  await b.getByTestId('message-input').fill('Are you there?');
  await b.getByTestId('send').click();
  await a.waitForTimeout(3000);
  await expect(a.getByTestId('contact')).toHaveCount(0);
  await expect(a.getByText('Are you there?')).toHaveCount(0);
  people.onlyLocal();
});

test('Report a group member: blocked, and the email names the group', async () => {
  const { a, b } = await pair();
  const bId = (await myId(b)).replace(/ /g, '');
  await tab(a, 'add');
  await a.getByTestId('new-group').click();
  await a.getByTestId('group-name-input').fill('Seva team');
  for (const box of await a.getByTestId('group-pick').all()) await box.check();
  await a.getByTestId('group-create').click();
  await expect(a.getByTestId('peer-name')).toHaveText('Seva team');
  await a.getByTestId('group-info-open').click();
  const info = a.getByTestId('group-info');
  await expect(info.getByTestId('group-member')).toHaveCount(2);
  // No Report next to myself; one next to Ravi.
  await expect(info.getByTestId('report-member')).toHaveCount(1);
  a.once('dialog', (d) => void d.accept());
  await info.getByTestId('report-member').click();
  await expect(a.getByTestId('report-sheet')).toContainText('Blocked. You can also email us the details.');
  const body = await reportBody(a);
  expect(body).toContain(`Their P2P ID: ${bId}`);
  expect(body).toContain('Their name: Ravi');
  expect(body).toContain('In the group: Seva team');
  await a.getByTestId('report-sheet').getByRole('button', { name: 'Close' }).click();
  await a.keyboard.press('Escape');
  await tab(a, 'chats');
  await expect(a.getByTestId('contact')).toHaveCount(0);
  people.onlyLocal();
});

test('Terms and Privacy policy links on Welcome and under Me (open outside the app)', async () => {
  const ctx = await people.context();
  const p = await people.page(ctx);
  await p.goto(people.q());
  const check = async () => {
    const terms = p.getByTestId('terms');
    await expect(terms).toContainText('By continuing you agree to the Terms and the Privacy policy');
    const links = terms.locator('a');
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveText('Terms');
    await expect(links.nth(0)).toHaveAttribute('href', 'https://p2p.vilnek.in/terms/');
    await expect(links.nth(1)).toHaveText('Privacy policy');
    await expect(links.nth(1)).toHaveAttribute('href', 'https://p2p.vilnek.in/privacy/');
    // A new window: browsers open a tab, the phone apps hand it to the system browser.
    for (const l of await links.all()) {
      await expect(l).toHaveAttribute('target', '_blank');
      await expect(l).toHaveAttribute('rel', /noopener/);
    }
  };
  await expect(p.getByTestId('make-account')).toBeVisible();
  await check();
  await p.getByTestId('make-account').click();
  await doneWords(p);
  await tab(p, 'me');
  await check();
  // The Delete button is in red at the bottom of Me.
  await expect(p.getByTestId('delete-account')).toHaveText('Delete my account and data');
  await p.getByTestId('delete-account').click();
  const sheet = p.getByTestId('delete-sheet');
  await expect(sheet).toContainText('Delete my account and data?');
  await expect(sheet).toContainText('This erases your keys, chats, contacts and files from this device and removes your public card. Other devices with the same 24 words keep their copy. This can’t be undone.');
  await expect(sheet.getByTestId('delete-confirm')).toHaveText('Delete');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(p.getByTestId('tab-chats')).toBeVisible(); // still signed in
  people.onlyLocal();
});
