import { expect, test, type Page } from '@playwright/test';
import { People, fragment, makeInvite } from './fixtures';
import { join, tab } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// Files with no size limit (one data channel per transfer, resume after a drop) and a 3-person
// group, over real RTCDataChannels between browser profiles. LOCAL mock relay only.
// Test switches: ?fileDelay=N slows each outgoing file frame by N ms; ?testHooks=1 adds
// window.__p2pTest.drop() (closes every connection, as if the network went away).

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

/** Dr Vijay (sender, with the test switches) and Ravi, connected through an invite. */
async function pair(extra: string): Promise<{ a: Page; b: Page }> {
  const A = await people.person('Dr Vijay', extra);
  const link = await makeInvite(A.page);
  const b = await people.page(undefined, 'Ravi');
  await b.goto(`${people.q(extra)}${fragment(link)}`);
  await join(b, 'Ravi');
  await expect(A.page.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 20_000 });
  await expect(b.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 20_000 });
  // Ravi writes first: Dr Vijay is no longer a "new contact" for him, so his files come in at once.
  await b.getByTestId('message-input').fill('Ready for the film');
  await b.getByTestId('send').click();
  await expect(A.page.getByTestId('msg-them')).toHaveText(/Ready for the film/);
  return { a: A.page, b };
}

/** Every text the file lines show, recorded as it changes. */
async function recordLines(p: Page): Promise<void> {
  await p.evaluate(() => {
    const w = window as unknown as { __lines: string[] };
    w.__lines = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[data-testid=file-line]')) if (w.__lines.at(-1) !== el.textContent) w.__lines.push(el.textContent ?? '');
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}
const lines = (p: Page) => p.evaluate(() => (window as unknown as { __lines: string[] }).__lines);
const NONZERO_SPEED = /(^|· )(?!0\.0 )\d+(\.\d)? MB\/s/;

async function sendFile(a: Page, name: string, size: number): Promise<void> {
  await a.getByTestId('attach').click();
  await expect(a.getByTestId('original-note')).toHaveText('Sent as original, full quality');
  const chooser = a.waitForEvent('filechooser');
  await a.getByTestId('pick-files').click();
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) buffer.writeUInt32LE((i * 2654435761) >>> 0, i); // not all zeros
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer });
}

test('a 20 MB file: live speed on both sides, then "received, checked" with Save / Share', async () => {
  const { a, b } = await pair('&fileDelay=12');
  await recordLines(a);
  await recordLines(b);
  await sendFile(a, 'seva-film.bin', 20 * 1024 * 1024);
  await expect(b.getByTestId('file-them')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  await expect(a.getByTestId('file-me')).toHaveAttribute('data-state', 'done', { timeout: 20_000 });
  expect((await lines(a)).some((l) => NONZERO_SPEED.test(l))).toBe(true);
  expect((await lines(b)).some((l) => NONZERO_SPEED.test(l))).toBe(true);
  // Two lines: the name, then "20.0 MB · original"; how long it took (and "checked") in the tooltip.
  await expect(b.getByTestId('file-them').getByTestId('file-line')).toHaveText('20.0 MB · original');
  await expect(b.getByTestId('file-them').getByTestId('file-line')).toHaveAttribute('title', /^Received in \d+ (s|min \d+ s) · avg [\d.]+ MB\/s · checked$/);
  await expect(a.getByTestId('file-me').getByTestId('file-line')).toHaveText('20.0 MB · original');
  await expect(a.getByTestId('file-me').getByTestId('file-line')).toHaveAttribute('title', /^Sent in /);
  await expect(b.getByTestId('file-save-files')).toHaveText('Save'); // browser: Save · Share (the apps: Save to Files · Share or open)
  await expect(b.getByTestId('file-share')).toHaveText('Share');
  await expect(b.getByTestId('file-photos')).toHaveCount(0); // not an image or video (and not the app)
  // The chat still works (files have their own data channel).
  await a.getByTestId('message-input').fill('Did it arrive?');
  await a.getByTestId('send').click();
  await expect(b.getByTestId('msg-them')).toHaveText(/Did it arrive\?/);
  people.onlyLocal();
});

test('the connection drops in the middle of a file: it waits, then resumes and finishes checked', async () => {
  const { a, b } = await pair('&fileDelay=40&testHooks=1');
  await sendFile(a, 'big.bin', 20 * 1024 * 1024);
  const line = b.getByTestId('file-them').getByTestId('file-line');
  await expect(line).toHaveText(/^20\.0 MB · ([2-9]\d)% /, { timeout: 30_000 });
  await a.evaluate(() => (window as unknown as { __p2pTest: { drop(): void } }).__p2pTest.drop());
  await expect(b.getByTestId('file-them')).toHaveAttribute('data-state', 'waiting', { timeout: 20_000 });
  await expect(line).toHaveText(/^20\.0 MB · \d+% · Waiting for connection…$/);
  // Reconnect (the contact in the list): the transfer goes on from where it was.
  await tab(a, 'chats');
  await a.getByTestId('contact').click();
  await expect(b.getByTestId('file-them')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  await expect(a.getByTestId('file-me')).toHaveAttribute('data-state', 'done', { timeout: 20_000 });
  people.onlyLocal();
});

test('a 3-person group: create, invite, join, messages reach everyone (also through a member)', async () => {
  const A = await people.person('Dr Vijay');
  const a = A.page;
  const others: Page[] = [];
  for (const name of ['Ravi', 'Meera']) {
    const link = await makeInvite(a);
    const p = await people.page(undefined, name);
    await p.goto(`${people.q()}${fragment(link)}`);
    await join(p, name);
    await expect(p.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 20_000 });
    others.push(p);
  }
  const [b, c] = others;
  await tab(a, 'add');
  await a.getByTestId('new-group').click();
  await a.getByTestId('group-name-input').fill('Seva team');
  for (const box of await a.getByTestId('group-pick').all()) await box.check();
  await a.getByTestId('group-create').click();
  await expect(a.getByTestId('peer-name')).toHaveText('Seva team');
  await expect(a.getByTestId('group-count')).toHaveText('3 members');

  for (const p of [b, c]) {
    await tab(p, 'groups'); // group invites wait in the Groups tab
    await expect(p.getByTestId('group-invite-text')).toHaveText('Dr Vijay added you to Seva team', { timeout: 20_000 });
    await p.getByTestId('group-join').click();
    await expect(p.getByTestId('peer-name')).toHaveText('Seva team');
  }
  await a.getByTestId('message-input').fill('Namaste team');
  await a.getByTestId('send').click();
  for (const p of [b, c]) {
    await expect(p.getByTestId('gmsg-them').last()).toContainText('Namaste team', { timeout: 20_000 });
    await expect(p.getByTestId('gmsg-from').last()).toHaveText('Dr Vijay');
  }
  // Ravi and Meera are not connected to each other: Dr Vijay passes it on.
  await b.getByTestId('message-input').fill('Hi all');
  await b.getByTestId('send').click();
  await expect(c.getByTestId('gmsg-them').last()).toContainText('Hi all', { timeout: 20_000 });
  await expect(c.getByTestId('gmsg-from').last()).toHaveText('Ravi');
  await expect(a.getByTestId('gmsg-them').last()).toContainText('Hi all');
  // Members in the group's details; the admin removes Meera.
  await a.getByTestId('group-info-open').click();
  await expect(a.getByTestId('group-member')).toHaveCount(3);
  a.once('dialog', (d) => void d.accept());
  await a.getByTestId('group-member').filter({ hasText: 'Meera' }).getByTestId('group-remove').click();
  await expect(a.getByTestId('group-count')).toHaveText('2 members', { timeout: 15_000 });
  await a.keyboard.press('Escape');
  await a.getByTestId('message-input').fill('Only for Ravi now');
  await a.getByTestId('send').click();
  await expect(b.getByTestId('gmsg-them').last()).toContainText('Only for Ravi now', { timeout: 20_000 });
  await c.waitForTimeout(3000);
  await expect(c.getByText('Only for Ravi now')).toHaveCount(0);
  people.onlyLocal();
});

test('a new contact\'s file asks Accept / Decline at any size; a call from them says "New contact"', async () => {
  const A = await people.person('Dr Vijay');
  const link = await makeInvite(A.page);
  const b = await people.page(undefined, 'Ravi');
  await b.goto(`${people.q()}${fragment(link)}`);
  await join(b, 'Ravi');
  await expect(A.page.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 20_000 });
  await sendFile(A.page, 'small.txt', 2048);
  const card = b.getByTestId('file-them');
  await expect(card).toHaveAttribute('data-state', 'incoming', { timeout: 20_000 });
  await expect(card.getByTestId('file-line')).toHaveText('2 KB · Dr Vijay wants to send this');
  await card.getByTestId('file-accept').click();
  await expect(card).toHaveAttribute('data-state', 'done', { timeout: 20_000 });
  await A.page.getByTestId('voice-call').click();
  await expect(b.getByTestId('call-new')).toHaveText('New contact', { timeout: 15_000 });
  await b.getByTestId('decline').click();
  people.onlyLocal();
});

test('a group video call: it rings, two join, the caller sees both connected, then it ends', async () => {
  const A = await people.person('Dr Vijay');
  const a = A.page;
  const others: Page[] = [];
  for (const name of ['Ravi', 'Meera']) {
    const link = await makeInvite(a);
    const p = await people.page(undefined, name);
    await p.goto(`${people.q()}${fragment(link)}`);
    await join(p, name);
    await expect(p.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 20_000 });
    others.push(p);
  }
  await tab(a, 'add');
  await a.getByTestId('new-group').click();
  await a.getByTestId('group-name-input').fill('Seva team');
  for (const box of await a.getByTestId('group-pick').all()) await box.check();
  await a.getByTestId('group-create').click();
  for (const p of others) {
    await tab(p, 'groups');
    await p.getByTestId('group-join').click({ timeout: 20_000 });
    await expect(p.getByTestId('peer-name')).toHaveText('Seva team');
  }
  await a.getByTestId('group-video-call').click();
  for (const p of others) {
    await expect(p.getByTestId('gcall-title')).toHaveText('Dr Vijay is calling Seva team', { timeout: 20_000 });
    await p.getByTestId('gcall-join').click();
  }
  // The caller: me + Ravi + Meera, both connected (direct pairs with each of them).
  await expect(a.getByTestId('gcall-tile')).toHaveCount(3, { timeout: 30_000 });
  await expect(a.locator('[data-testid=gcall-tile][data-state=connected]')).toHaveCount(2, { timeout: 40_000 });
  await expect(a.getByTestId('gcall-count')).toContainText('3 in call');
  await a.getByTestId('gcall-mic').click();
  await expect(a.getByTestId('gcall-mic')).toHaveAttribute('aria-label', 'Unmute');
  await a.getByTestId('gcall-leave').click();
  await expect(a.getByTestId('gcall-screen')).toHaveCount(0, { timeout: 10_000 });
  people.onlyLocal();
});
