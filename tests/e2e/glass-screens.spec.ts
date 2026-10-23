import { expect, test, type Page } from '@playwright/test';
import { People, fragment, makeInvite } from './fixtures';
import { confirmLink, join, tab, doneWords } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// The liquid-glass theme (23 Oct 2026), lived-in: screenshots for Dr Vijay into docs/screens/, plus
// checks of the floating bar, composer and headers, day headings, the Calls line, the file line and
// the group details pane on wide screens. LOCAL mock relay only.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

/** A colourful 640×420 "photo" made in the page (gradients and circles), as PNG bytes. */
async function photo(p: Page): Promise<Buffer> {
  const b64 = await p.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 420;
    const g = c.getContext('2d')!;
    const bg = g.createLinearGradient(0, 0, 640, 420);
    bg.addColorStop(0, '#ff9a3c');
    bg.addColorStop(0.5, '#e8467c');
    bg.addColorStop(1, '#5b2bd6');
    g.fillStyle = bg;
    g.fillRect(0, 0, 640, 420);
    for (const [x, y, r, col] of [[160, 210, 120, '#ffd166'], [320, 210, 90, '#06d6a0'], [480, 210, 120, '#4fd1e8'], [320, 210, 40, '#ffffff']] as const) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = col;
      g.globalAlpha = 0.8;
      g.fill();
    }
    return c.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}

async function send(p: Page, text: string): Promise<void> {
  await p.getByTestId('message-input').fill(text);
  await p.getByTestId('send').click();
}

async function pick(p: Page, testid: 'pick-media' | 'pick-files', name: string, mimeType: string, buffer: Buffer): Promise<void> {
  await p.getByTestId('attach').click();
  const chooser = p.waitForEvent('filechooser');
  await p.getByTestId(testid).click();
  await (await chooser).setFiles({ name, mimeType, buffer });
}

/** Adds older messages straight into the database (as if they came on earlier days). */
async function addOld(p: Page, peer: string, items: { from: 'me' | 'them'; text: string; daysAgo: number }[]): Promise<void> {
  await p.evaluate(
    ({ peer, items }) =>
      new Promise<void>((resolve, reject) => {
        const r = indexedDB.open('p2ptalk');
        r.onsuccess = () => {
          const tx = r.result.transaction('messages', 'readwrite');
          const s = tx.objectStore('messages');
          for (const [i, m] of items.entries()) {
            const d = new Date();
            d.setDate(d.getDate() - m.daysAgo);
            d.setHours(10 + i, 15, 0, 0);
            s.add({ peer, from: m.from, text: m.text, ts: d.getTime(), mid: `old${i}` });
          }
          tx.oncomplete = () => (r.result.close(), resolve());
          tx.onerror = () => reject(tx.error);
        };
      }),
    { peer, items },
  );
}

test('liquid glass: lived-in screens at 360 px and 1280 px', async () => {
  test.setTimeout(240_000);
  const ctx = await people.context({ viewport: { width: 360, height: 740 }, hasTouch: true });
  const a = await people.page(ctx, 'Dr Vijay');
  await a.goto(people.q('&fileDelay=0'));
  await a.getByTestId('name').fill('Dr Vijay');
  await a.getByTestId('make-account').click();
  await doneWords(a);
  // After a tab change the lens slides for 0.25 s: wait for it to settle before each picture.
  const shot = async (name: string) => {
    await a.waitForTimeout(400);
    await a.screenshot({ path: `docs/screens/${name}.png` });
  };

  // Ravi (a computer) and Asha join from Dr Vijay's invites; Ravi and Asha also know each other.
  const others: Record<string, Page> = {};
  for (const n of ['Ravi', 'Asha']) {
    const link = await makeInvite(a);
    const p = await people.page(undefined, n);
    await p.goto(`${people.q()}${fragment(link)}`);
    await join(p, n);
    await expect(a.getByTestId('peer-name')).toHaveText(n, { timeout: 20_000 });
    others[n] = p;
    await a.getByTestId('chat-back').click();
  }
  const { Ravi: r, Asha: s } = others;
  const l2 = await makeInvite(r);
  await s.goto(`${people.q()}${fragment(l2)}`);
  await confirmLink(s);
  await expect(s.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 20_000 });
  await send(s, 'Namaste Ravi!');

  // A conversation with Ravi: older days, a photo, a file, messages.
  await tab(a, 'chats');
  await a.getByTestId('contact').filter({ hasText: 'Ravi' }).click();
  const id = await a.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const q = indexedDB.open('p2ptalk');
        q.onsuccess = () => {
          const g = q.result.transaction('contacts').objectStore('contacts').getAll();
          g.onsuccess = () => resolve((g.result as { id: string; name: string }[]).find((c) => c.name === 'Ravi')!.id);
        };
      }),
  );
  await addOld(a, id, [
    { from: 'them', text: 'Shall we plan the health camp?', daysAgo: 3 },
    { from: 'me', text: 'Yes, Sunday works.', daysAgo: 3 },
    { from: 'them', text: 'Volunteers list is coming.', daysAgo: 1 },
  ]);
  await a.getByTestId('chat-back').click();
  await a.getByTestId('contact').filter({ hasText: 'Ravi' }).click();
  // Day headings: a weekday (3 days ago), Yesterday, Today (the "Connected" note is today's).
  await expect(a.getByTestId('day')).toHaveCount(3);
  await expect(a.getByTestId('day').nth(1)).toHaveText('Yesterday');
  await expect(a.getByTestId('day').nth(2)).toHaveText('Today');
  await tab(r, 'chats');
  await r.getByTestId('contact').filter({ hasText: 'Dr Vijay' }).click();
  await send(a, 'Morning Ravi! Please send the photos.');
  await expect(r.getByTestId('msg-them').last()).toHaveText(/Please send the photos/);
  await pick(r, 'pick-media', 'Diwali-rangoli-at-the-Vilnek-office-courtyard.png', 'image/png', await photo(r));
  await expect(a.getByTestId('file-them').first().getByTestId('file-thumb').locator('img')).toBeVisible({ timeout: 30_000 });
  const big = Buffer.alloc(5 * 1024 * 1024, 7);
  await pick(r, 'pick-files', 'Health-camp-volunteers-October-2026.pdf', 'application/pdf', big);
  await expect(a.getByTestId('file-them').last()).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await expect(a.getByTestId('file-them').last().getByTestId('file-line')).toHaveText('5.0 MB · original');
  await expect(a.getByTestId('day')).toHaveCount(3); // still one Today
  await send(r, 'Here they are 🙏');
  await expect(a.getByTestId('msg-them').last()).toHaveText(/Here they are/);
  // Glass: the composer floats, the header is translucent.
  const comp = (await a.locator('.compose').boundingBox())!;
  expect(comp.y + comp.height).toBeLessThanOrEqual(740 - 8);
  expect(await a.locator('.chat-hd').evaluate((e) => getComputedStyle(e).backdropFilter)).toContain('blur');
  await shot('360-glass-chat');
  await a.getByTestId('attach').click();
  await expect(a.getByTestId('send-sheet')).toBeVisible();
  await shot('360-glass-sheet');
  await a.keyboard.press('Escape');

  // A video call from Ravi: the controls pill over the video.
  await r.getByTestId('video-call').click();
  await a.getByTestId('accept').click({ timeout: 20_000 });
  await expect(a.getByTestId('call-status')).toHaveText(/^\d\d:\d\d$/, { timeout: 25_000 });
  await a.waitForTimeout(1500);
  await a.locator('.call').click({ position: { x: 180, y: 300 } }); // controls show
  await shot('360-glass-call');
  await a.getByTestId('hang-up').click();
  await expect(a.getByTestId('call-screen')).toHaveCount(0, { timeout: 10_000 }); // closes by itself
  await expect(r.getByTestId('call-screen')).toHaveCount(0, { timeout: 10_000 });
  if (await a.getByTestId('chat-back').isVisible()) await a.getByTestId('chat-back').click();

  // Calls: the duration sits on the right, never cut off.
  await tab(a, 'calls');
  await expect(a.getByTestId('call-row').first().getByTestId('call-minutes')).toHaveText(/^\d+ min$/);
  await shot('360-glass-calls');

  // A group with a call running (Ravi calls, Asha joins, Dr Vijay hasn't joined yet).
  await tab(a, 'groups');
  await a.getByTestId('groups-new').click();
  await a.getByTestId('group-name-input').fill('Seva team');
  for (const box of await a.getByTestId('group-pick').all()) await box.check();
  await a.getByTestId('group-create').click();
  for (const p of [r, s]) {
    await tab(p, 'groups');
    await p.getByTestId('group-join').click({ timeout: 20_000 });
    await expect(p.getByTestId('peer-name')).toHaveText('Seva team'); // the join is saved, then the group opens
  }
  await send(s, 'Camp list is ready ✅');
  await expect(a.getByTestId('gmsg-them').last()).toContainText('Camp list is ready');
  await a.getByTestId('chat-back').click();
  await r.getByTestId('group-voice-call').click();
  await s.getByTestId('gcall-join').click({ timeout: 20_000 });
  await a.getByTestId('gcall-decline').click({ timeout: 20_000 });
  await tab(a, 'groups');
  await expect(a.getByTestId('group-call-on')).toBeVisible({ timeout: 20_000 });
  await shot('360-glass-groups');
  await tab(a, 'chats');
  await expect(a.getByTestId('contact')).toHaveCount(2);
  await shot('360-glass-chats');

  // The glass bar over something bright: Me, scrolled so the ID card passes under the bar.
  await a.setViewportSize({ width: 360, height: 560 }); // a shorter phone, so the card can pass under the bar
  await tab(a, 'me');
  await expect(a.locator('.idcard')).toBeVisible();
  await a.locator('.list-pane').evaluate((el) => {
    const card = el.querySelector('.idcard') as HTMLElement;
    el.scrollTop = card.offsetTop + card.offsetHeight - el.clientHeight + 40;
  });
  const bar = (await a.locator('.nav').boundingBox())!;
  expect(bar.x).toBeGreaterThanOrEqual(10);
  expect(bar.y + bar.height).toBeLessThanOrEqual(560 - 8);
  await shot('360-glass-over-photo');

  // Wide (Ravi's computer): floating panels; the open group's details in the right-hand pane.
  await r.setViewportSize({ width: 1280, height: 800 });
  await r.getByTestId('gcall-leave').click({ timeout: 5000 }).catch(() => undefined);
  await tab(r, 'groups');
  await r.getByTestId('group').click();
  await expect(r.getByTestId('group-info')).toBeVisible();
  await expect(r.getByTestId('group-info').getByTestId('group-member')).toHaveCount(3);
  await expect(r.getByTestId('group-info').getByTestId('group-admin')).toHaveCount(1);
  await expect(r.getByTestId('group-info').getByTestId('lock-chat')).toBeVisible();
  await expect(r.getByTestId('group-info').getByTestId('group-leave')).toBeVisible();
  await r.screenshot({ path: 'docs/screens/1280-glass.png' });
});
