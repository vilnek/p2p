import { expect, test, type Page } from '@playwright/test';
import { People, fragment, makeInvite } from './fixtures';
import { confirmLink, join, tab, doneWords } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// Store-screenshot review fixes: photo previews, send sheet icons, file names cut in the middle, the Me
// screen on a phone, fresh list previews and note order on wide screens, "bye" on closing, and BUG-7
// (received files are not copied into IndexedDB). LOCAL mock relay only.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

// A 2×2 PNG (red, green, blue, white).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

/** Dr Vijay and Ravi connected; Ravi wrote first (so files from Dr Vijay come in at once). */
async function pair(extra = ''): Promise<{ a: Page; b: Page }> {
  const A = await people.person('Dr Vijay', extra);
  const link = await makeInvite(A.page);
  const b = await people.page(undefined, 'Ravi');
  await b.goto(`${people.q(extra)}${fragment(link)}`);
  await join(b, 'Ravi');
  await expect(A.page.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 20_000 });
  await expect(b.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 20_000 });
  await b.getByTestId('message-input').fill('Ready');
  await b.getByTestId('send').click();
  await expect(A.page.getByTestId('msg-them')).toHaveText(/Ready/);
  return { a: A.page, b };
}

async function pickFile(a: Page, testid: 'pick-media' | 'pick-files', name: string, mimeType: string, buffer: Buffer): Promise<void> {
  await a.getByTestId('attach').click();
  const chooser = a.waitForEvent('filechooser');
  await a.getByTestId(testid).click();
  await (await chooser).setFiles({ name, mimeType, buffer });
}

test('photos: a preview in the bubble on both sides, full view on tap; send sheet icons; names keep their extension', async () => {
  const { a, b } = await pair();
  await a.getByTestId('attach').click();
  await expect(a.getByTestId('pick-media').locator('svg')).toHaveAttribute('data-icon', 'image');
  await expect(a.getByTestId('pick-files').locator('svg')).toHaveAttribute('data-icon', 'folder');
  await expect(a.getByTestId('pick-camera').locator('svg')).toHaveAttribute('data-icon', 'camera');
  await a.keyboard.press('Escape');

  const name = 'Diwali-rangoli-at-the-Vilnek-office-courtyard-2026.png';
  await pickFile(a, 'pick-media', name, 'image/png', PNG);
  const got = b.getByTestId('file-them');
  await expect(got).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await expect(got.getByTestId('file-thumb').locator('img')).toBeVisible({ timeout: 10_000 });
  await expect(a.getByTestId('file-me').getByTestId('file-thumb').locator('img')).toBeVisible({ timeout: 10_000 });
  // The name is cut in the middle: the end with the extension stays.
  await expect(got.getByTestId('file-name')).toHaveText(name);
  await expect(got.getByTestId('file-name').locator('.z')).toHaveText(/\.png$/);
  // Tap: the photo full screen, from the file on this device (a blob: image).
  await got.getByTestId('file-thumb').click();
  const img = b.getByTestId('viewer').locator('img');
  await expect(img).toBeVisible();
  expect(await img.getAttribute('src')).toMatch(/^blob:/);
  expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(2);
  await b.getByTestId('viewer-close').click();
  await expect(b.getByTestId('viewer')).toHaveCount(0);

  // After reopening the chat, the preview is still there (kept with the message).
  await tab(b, 'add');
  await b.getByTestId('show-my-code').click();
  await tab(b, 'chats');
  await b.getByTestId('contact').click();
  await expect(b.getByTestId('file-them').getByTestId('file-thumb').locator('img')).toBeVisible();
  people.onlyLocal();
});

// A tiny real JPEG (2×2, made from the PNG above), as an iPhone or a camera would send it "as a file".
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAgACAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/ASeea5mkubmRpZZWLu7kszMxySSeSSeSaioor5M/oA//9k=',
  'base64',
);

test('a photo sent as a file: a preview on the receiving side; Share never ends in "Permission denied"', async () => {
  const { a, b } = await pair();
  // Chrome's share sheet: takes JPEG, says "Permission denied" for an iPhone HEIC photo (as real Chrome does).
  await b.evaluate(() => {
    const w = window as unknown as { __shared: string[] };
    w.__shared = [];
    const allowed = /\.(jpe?g|png|gif|webp)$/i;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (d: ShareData) => {
        const f = d.files![0];
        if (!allowed.test(f.name)) throw new DOMException('Permission denied', 'NotAllowedError');
        w.__shared.push(f.name);
      },
    });
  });
  // 1. A JPEG through "Files": the receiver draws its own preview from the received file.
  await pickFile(a, 'pick-files', 'IMG_0007.jpg', 'image/jpeg', JPEG);
  const jpg = b.getByTestId('file-them').filter({ hasText: 'IMG_0007.jpg' });
  await expect(jpg).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await expect(jpg.getByTestId('file-thumb').locator('img')).toBeVisible({ timeout: 10_000 });
  await jpg.getByTestId('file-share').click();
  await expect.poll(() => b.evaluate(() => (window as unknown as { __shared: string[] }).__shared)).toEqual(['IMG_0007.jpg']);

  // 2. An iPhone HEIC photo: Chrome can't draw it (the card stays) and its share sheet won't take it,
  //    so Share saves it (same name, same bytes) and says so: no "Permission denied".
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(200, 7)]);
  await pickFile(a, 'pick-files', 'IMG_0042.HEIC', 'image/heic', heic);
  const hc = b.getByTestId('file-them').filter({ hasText: 'IMG_0042.HEIC' });
  await expect(hc).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  const download = b.waitForEvent('download');
  await hc.getByTestId('file-share').click();
  const d = await download;
  expect(d.suggestedFilename()).toBe('IMG_0042.HEIC');
  const fs = await import('node:fs/promises');
  expect(Buffer.compare(await fs.readFile((await d.path())!), heic)).toBe(0);
  await expect(b.getByTestId('toast')).toHaveText('This browser can’t share this file, so it was saved instead.');
  await expect(b.getByTestId('toast')).not.toContainText(/denied/i);
  people.onlyLocal();
});

test('wide: the list preview follows the chat; "Connected" keeps its place when the chat is reopened', async () => {
  const { a, b } = await pair();
  await tab(a, 'chats');
  await b.getByTestId('message-input').fill('Second message, after connecting');
  await b.getByTestId('send').click();
  await expect(a.getByTestId('msg-them').last()).toHaveText(/Second message/);
  await expect(a.getByTestId('contact').getByTestId('chat-preview')).toHaveText('Second message, after connecting');
  await a.getByTestId('message-input').fill('My reply');
  await a.getByTestId('send').click();
  await expect(a.getByTestId('contact').getByTestId('chat-preview')).toHaveText('You: My reply');

  // Reopen: the notes stay before the messages that came after them.
  await tab(a, 'add');
  await a.getByTestId('show-my-code').click();
  await tab(a, 'chats');
  await a.getByTestId('contact').click();
  await expect(a.getByTestId('msg-me').last()).toHaveText(/My reply/);
  const order = await a.getByTestId('messages').evaluate((el) => [...el.children].map((c) => (c as HTMLElement).dataset.testid ?? ''));
  expect(order.indexOf('success-note')).toBeGreaterThan(-1);
  expect(order.indexOf('success-note')).toBeLessThan(order.lastIndexOf('msg-them'));
  expect(order.indexOf('joined-note')).toBe(order.indexOf('success-note') + 1);
  expect(order.at(-1)).toBe('msg-me');
});

test('closing the app says "bye": the other side shows offline at once (not after ~12 s)', async () => {
  const { a, b } = await pair();
  await expect(a.getByTestId('presence')).toContainText('online');
  const t0 = Date.now();
  await b.close();
  await expect(a.getByTestId('presence')).toContainText('offline', { timeout: 6000 });
  expect(Date.now() - t0).toBeLessThan(6000);
});

test('Me on a 360 px phone: the ID on two balanced lines, no "Coming soon", no Notifications, Terms above the tab bar', async () => {
  const ctx = await people.context({ viewport: { width: 360, height: 740 }, hasTouch: true });
  const p = await people.page(ctx, 'phone');
  await p.goto(people.q());
  await p.getByTestId('name').fill('Ravi');
  await p.getByTestId('make-account').click();
  await doneWords(p);
  await tab(p, 'me');
  await expect(p.getByTestId('my-id').locator('.idh')).toHaveCount(2); // the Me list is drawn after a read
  const halves = await p.getByTestId('my-id').locator('.idh').evaluateAll((els) => els.map((e) => ({ text: e.textContent, top: e.getBoundingClientRect().top })));
  expect(halves.map((x) => x.text!.split(' ').length)).toEqual([3, 3]);
  expect(await p.getByTestId('my-id').textContent()).toMatch(/^\d{4}( \d{4}){5}$/);
  await expect(p.locator('body')).not.toContainText('Coming soon');
  await expect(p.getByTestId('me-notifications')).toHaveCount(0);
  await expect(p.getByTestId('me-chat-lock')).toContainText('Off');
  await p.getByTestId('terms').scrollIntoViewIfNeeded();
  const terms = (await p.getByTestId('terms').boundingBox())!;
  const nav = (await p.locator('.nav').boundingBox())!;
  expect(terms.y + terms.height).toBeLessThanOrEqual(nav.y + 1);
  await p.screenshot({ path: 'docs/screens/360-me.png' });
});

test('BUG-7: a received 20 MB file stays in the private file area; IndexedDB does not grow by its size', async () => {
  const { a, b } = await pair();
  const idb = () => b.evaluate(async () => ((await navigator.storage.estimate()) as StorageEstimate & { usageDetails?: { indexedDB?: number } }).usageDetails?.indexedDB ?? -1);
  const before = await idb();
  const size = 20 * 1024 * 1024;
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) buffer.writeUInt32LE((i * 2654435761) >>> 0, i);
  await pickFile(a, 'pick-files', 'seva-film.bin', 'application/octet-stream', buffer);
  await expect(b.getByTestId('file-them')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  // The message keeps only the file's name in the private file area.
  const msg = await b.evaluate(
    () =>
      new Promise<{ blob: boolean; opfs: string | null }>((resolve) => {
        const r = indexedDB.open('p2ptalk');
        r.onsuccess = () => {
          const g = r.result.transaction('messages').objectStore('messages').getAll();
          g.onsuccess = () => {
            const m = (g.result as { file?: unknown; blob?: Blob; opfs?: string }[]).find((x) => x.file);
            resolve({ blob: !!m?.blob, opfs: m?.opfs ?? null });
            r.result.close();
          };
        };
      }),
  );
  expect(msg.blob).toBe(false);
  expect(msg.opfs).toMatch(/seva-film\.bin$/);
  await b.waitForTimeout(1000);
  const after = await idb();
  if (before >= 0 && after >= 0) expect(after - before).toBeLessThan(5 * 1024 * 1024);
  // Reopened, the file still has Save / Share (read from the private file area).
  await tab(b, 'add');
  await b.getByTestId('show-my-code').click();
  await tab(b, 'chats');
  await b.getByTestId('contact').click();
  await expect(b.getByTestId('file-them').getByTestId('file-save-files')).toHaveText('Save');
  await expect(b.getByTestId('file-them')).toHaveAttribute('data-state', 'done');
});

test('screens at 360 px for docs/screens: chat lock, send sheet, photo preview', async () => {
  const ctx = await people.context({ viewport: { width: 360, height: 740 }, hasTouch: true });
  const a = await people.page(ctx, 'Dr Vijay');
  await a.goto(people.q());
  await a.getByTestId('name').fill('Dr Vijay');
  await a.getByTestId('make-account').click();
  await doneWords(a);
  const shot = (name: string) => a.screenshot({ path: `docs/screens/360-${name}.png` });
  const names = ['Ravi', 'Asha'];
  const others: Page[] = [];
  for (const n of names) {
    const link = await makeInvite(a);
    const p = await people.page(undefined, n);
    await p.goto(`${people.q()}${fragment(link)}`);
    await join(p, n);
    await expect(a.getByTestId('peer-name')).toHaveText(n, { timeout: 20_000 });
    await p.getByTestId('message-input').fill(n === 'Ravi' ? 'Namaste! Photos from Diwali coming.' : 'See you at the seva camp');
    await p.getByTestId('send').click();
    await expect(a.getByTestId('msg-them').last()).toHaveText(/Namaste|seva/);
    others.push(p);
    if (n === 'Ravi') await a.getByTestId('chat-back').click();
  }
  const [ravi] = others;
  // Ravi sends a photo: the preview in Dr Vijay's chat with Asha open → go to Ravi.
  await a.getByTestId('chat-back').click();
  await tab(a, 'chats');
  await a.getByTestId('contact').filter({ hasText: 'Ravi' }).click();
  await a.getByTestId('message-input').fill('Please send them!');
  await a.getByTestId('send').click();
  await expect(ravi.getByTestId('msg-them').last()).toHaveText(/Please send/);
  await pickFile(ravi, 'pick-media', 'Diwali-rangoli-at-the-Vilnek-office-courtyard.png', 'image/png', PNG);
  await expect(a.getByTestId('file-them').getByTestId('file-thumb').locator('img')).toBeVisible({ timeout: 30_000 });
  await shot('chat-photo');
  await a.getByTestId('attach').click();
  await expect(a.getByTestId('send-sheet')).toBeVisible();
  await shot('send-sheet');
  await a.keyboard.press('Escape');
  // Lock Ravi's chat.
  await a.getByTestId('peer-info-open').click();
  await a.getByTestId('lock-chat').scrollIntoViewIfNeeded();
  await shot('info-lock');
  await a.getByTestId('lock-chat').click();
  await a.getByTestId('code-new').fill('2580');
  await a.getByTestId('code-again').fill('2580');
  await shot('set-code');
  await a.getByTestId('code-set').click();
  await tab(a, 'chats');
  await expect(a.getByTestId('locked-chats')).toBeVisible();
  await ravi.getByTestId('message-input').fill('Secret');
  await ravi.getByTestId('send').click();
  await expect(a.getByTestId('toast')).toHaveText('New message');
  await shot('chats-locked');
  await a.getByTestId('locked-chats').click();
  await a.getByTestId('code-input').fill('1111');
  await a.getByTestId('code-go').click();
  await expect(a.getByTestId('code-sheet').getByTestId('error')).toContainText('Try again');
  await shot('code-wrong');
  await expect(a.getByTestId('code-go')).toBeEnabled({ timeout: 5000 });
  await a.getByTestId('code-input').fill('2580');
  await a.getByTestId('code-go').click();
  await expect(a.getByTestId('locked-list')).toBeVisible();
  await shot('locked-chats');
  await a.getByTestId('back').click();
  await tab(a, 'me');
  await a.getByTestId('me-chat-lock').click();
  await shot('chat-lock');
});

test('Groups tab: newest first, "Sender: text", a locked group shows "Locked", a running call shows "Call on · Join" (1280 and 360 screens)', async () => {
  const { a, b } = await pair();
  // A third person, so a group call keeps running after Dr Vijay declines.
  const link = await makeInvite(a);
  const c = await people.page(undefined, 'Asha');
  await c.goto(`${people.q()}${fragment(link)}`);
  await join(c, 'Asha');
  await expect(a.getByTestId('peer-name')).toHaveText('Asha', { timeout: 20_000 });
  // Ravi and Asha know each other too (the call goes straight between them).
  const link2 = await makeInvite(b);
  await c.goto(`${people.q()}${fragment(link2)}`);
  await confirmLink(c);
  await expect(c.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 20_000 });
  const makeGroup = async (name: string, members: Page[]) => {
    await tab(a, 'groups');
    await a.getByTestId('groups-new').click();
    await a.getByTestId('group-name-input').fill(name);
    for (const box of await a.getByTestId('group-pick').all()) await box.check();
    await a.getByTestId('group-create').click();
    await expect(a.getByTestId('peer-name')).toHaveText(name);
    for (const m of members) {
      await tab(m, 'groups');
      await m.getByTestId('group-invite').filter({ hasText: name }).getByTestId('group-join').click({ timeout: 20_000 });
      await expect(m.getByTestId('peer-name')).toHaveText(name);
    }
  };
  await makeGroup('Family', [b]);
  await b.getByTestId('message-input').fill('Dinner at 8?');
  await b.getByTestId('send').click();
  await expect(a.getByTestId('gmsg-them').last()).toContainText('Dinner at 8?');
  await a.getByTestId('group-info-open').click();
  await a.getByTestId('lock-chat').click();
  await a.getByTestId('code-new').fill('2580');
  await a.getByTestId('code-again').fill('2580');
  await a.getByTestId('code-set').click();
  await makeGroup('Seva team', [b, c]);
  await b.getByTestId('message-input').fill('Camp list is ready');
  await b.getByTestId('send').click();
  await expect(a.getByTestId('gmsg-them').last()).toContainText('Camp list is ready');
  // Ravi starts a group call and Asha joins; Dr Vijay declines for now: the call goes on.
  await b.getByTestId('group-voice-call').click();
  await c.getByTestId('gcall-join').click({ timeout: 20_000 });
  await expect(c.locator('.gcall.joined')).not.toContainText('Connecting', { timeout: 20_000 }); // Ravi and Asha talk
  await a.getByTestId('gcall-decline').click({ timeout: 20_000 });
  await tab(a, 'groups');
  await expect(a.locator('.list-pane .hd')).toContainText('Groups');
  const rows = a.getByTestId('group');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByTestId('group-name')).toHaveText('Seva team');
  await expect(rows.nth(0).getByTestId('group-call-on')).toHaveText('Call on · Join', { timeout: 20_000 });
  await expect(rows.nth(1).getByTestId('group-name')).toHaveText('Family');
  await expect(rows.nth(1).getByTestId('chat-preview')).toHaveText('Locked');
  await expect(a.locator('.list-pane')).not.toContainText('Dinner');
  await a.screenshot({ path: 'docs/screens/1280-groups.png' });
  await a.setViewportSize({ width: 360, height: 740 });
  if (await a.getByTestId('chat-back').isVisible()) await a.getByTestId('chat-back').click();
  await tab(a, 'groups');
  await expect(a.getByTestId('group-call-on')).toBeVisible();
  await a.screenshot({ path: 'docs/screens/360-groups.png' });
  // Chats: 1:1 only.
  await tab(a, 'chats');
  await expect(a.getByTestId('group')).toHaveCount(0);
  await expect(a.getByTestId('contact')).toHaveCount(2);
  // The call's group opens with its own Join pill.
  await tab(a, 'groups');
  await a.getByTestId('group').first().click();
  await expect(a.getByTestId('group-call-join')).toBeVisible();
});
