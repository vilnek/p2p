import { expect, test, type Page } from '@playwright/test';
import { People, fragment, makeInvite } from './fixtures';
import { join, tab, doneWords } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// Profile and group pictures: set with a crop, re-encoded at 256×256 without EXIF, sent only directly
// to contacts (never to relays), shown in lists, headers and calls; changes and "Nobody" reach the
// other side; a group's picture reaches its members. LOCAL mock relay only.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

const PHONE = { viewport: { width: 360, height: 740 }, hasTouch: true };

/** A colourful JPEG (made in the page) with an EXIF block holding a GPS position spliced in. */
async function jpegWithExif(p: Page, hue: number): Promise<Buffer> {
  const b64 = await p.evaluate((hue) => {
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 900;
    const g = c.getContext('2d')!;
    const bg = g.createRadialGradient(600, 380, 40, 600, 450, 700);
    bg.addColorStop(0, `hsl(${hue}, 90%, 70%)`);
    bg.addColorStop(1, `hsl(${(hue + 60) % 360}, 70%, 30%)`);
    g.fillStyle = bg;
    g.fillRect(0, 0, 1200, 900);
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.beginPath();
    g.arc(600, 360, 170, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.ellipse(600, 860, 360, 300, 0, 0, Math.PI * 2);
    g.fill();
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  }, hue);
  const jpg = Buffer.from(b64, 'base64');
  const payload = Buffer.concat([Buffer.from('Exif\0\0MM\0*'), Buffer.from('GPSLatitude 28.6139 N GPSLongitude 77.2090 E Camera: Test')]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  return Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]);
}

async function choosePhoto(p: Page, open: () => Promise<void>, file: Buffer, shot?: string): Promise<void> {
  await open();
  const chooser = p.waitForEvent('filechooser');
  await p.getByTestId('photo-choose').click();
  await (await chooser).setFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: file });
  await expect(p.getByTestId('crop-sheet')).toBeVisible();
  await expect(p.getByTestId('crop-save')).toBeEnabled();
  // Zoom in a little and drag: the crop follows.
  await p.getByTestId('crop-zoom').fill('1.4');
  const box = (await p.getByTestId('crop').boundingBox())!;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 10);
  await p.mouse.up();
  if (shot) await p.screenshot({ path: `docs/screens/${shot}.png` });
  await p.getByTestId('crop-save').click();
  await expect(p.getByTestId('toast')).toHaveText('Photo saved');
}

/** What this device keeps as my picture: size, type, metadata, decoded size. */
const myStored = (p: Page) =>
  p.evaluate(
    () =>
      new Promise<{ size: number; type: string; meta: boolean; w: number; h: number }>((resolve) => {
        const r = indexedDB.open('p2ptalk');
        r.onsuccess = () => {
          const g = r.result.transaction('kv').objectStore('kv').get('myPhoto');
          g.onsuccess = async () => {
            const m = g.result as { t: string; b: Uint8Array };
            const text = new TextDecoder('latin1').decode(m.b);
            const bmp = await createImageBitmap(new Blob([m.b], { type: m.t }));
            resolve({ size: m.b.length, type: m.t, meta: /Exif|GPS|Camera/.test(text), w: bmp.width, h: bmp.height });
            r.result.close();
          };
        };
      }),
  );

test('profile and group pictures: crop, no EXIF, only to contacts, shown in list / header / call; changes, "Nobody", group picture', async () => {
  test.setTimeout(180_000);
  const actx = await people.context(PHONE);
  const a = await people.page(actx, 'Dr Vijay');
  await a.goto(people.q());
  await a.getByTestId('name').fill('Dr Vijay');
  await a.getByTestId('make-account').click();
  await doneWords(a);
  const link = await makeInvite(a);
  const bctx = await people.context(PHONE);
  const b = await people.page(bctx, 'Ravi');
  await b.goto(`${people.q()}${fragment(link)}`);
  await join(b, 'Ravi');
  await expect(b.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 20_000 });
  await expect(a.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 20_000 });
  await a.getByTestId('chat-back').click();

  // Dr Vijay sets a photo: the crop, then a small picture with no EXIF / GPS.
  await tab(a, 'me');
  await choosePhoto(a, () => a.getByTestId('me-photo').click(), await jpegWithExif(a, 200), '360-photo-me');
  const mine = await myStored(a);
  expect(mine.meta).toBe(false);
  expect(mine.size).toBeLessThanOrEqual(32 * 1024);
  expect([mine.w, mine.h]).toEqual([256, 256]);
  expect(['image/webp', 'image/jpeg']).toContain(mine.type);
  await expect(a.getByTestId('me-photo').getByTestId('avatar-photo')).toBeVisible();

  // Ravi sees it in the chat header and (after Back) in his list.
  await expect(b.locator('.chat-hd [data-testid=avatar-photo]')).toBeVisible({ timeout: 15_000 });
  const first = await b.locator('.chat-hd [data-testid=avatar-photo]').getAttribute('src');
  expect(first).toMatch(/^blob:/);
  await b.getByTestId('peer-info-open').click();
  await expect(b.getByTestId('photo-trust')).toHaveText('The photo is chosen by them. To be sure it’s them, compare the safety pictures.');
  await expect(b.getByTestId('peer-emoji')).toBeVisible();
  await b.keyboard.press('Escape');
  await b.getByTestId('chat-back').click();
  await expect(b.getByTestId('contact').getByTestId('avatar-photo')).toBeVisible();
  await b.screenshot({ path: 'docs/screens/360-photo-chats.png' });

  // A call from Dr Vijay rings on Ravi's phone with the photo.
  await tab(a, 'chats');
  await a.getByTestId('contact').click();
  await a.getByTestId('voice-call').click();
  await expect(b.getByTestId('accept')).toBeVisible({ timeout: 20_000 });
  await expect(b.locator('.call .ring-av [data-testid=avatar-photo]')).toBeVisible();
  await b.screenshot({ path: 'docs/screens/360-photo-call.png' });
  await b.getByTestId('decline').click();
  // "Ravi declined": back to the chat by itself.

  // Dr Vijay changes it: Ravi's copy updates, and his chat says so.
  await expect(a.getByTestId('call-screen')).toHaveCount(0, { timeout: 15_000 });
  if (await a.getByTestId('chat-back').isVisible()) await a.getByTestId('chat-back').click();
  await tab(a, 'me');
  await choosePhoto(a, () => a.getByTestId('me-photo').click(), await jpegWithExif(a, 20));
  await expect(b.getByTestId('call-screen')).toHaveCount(0, { timeout: 15_000 });
  if (await b.getByTestId('chat-back').isVisible()) await b.getByTestId('chat-back').click();
  await tab(b, 'chats');
  await b.getByTestId('contact').click();
  await expect(b.getByTestId('chat-note')).toHaveText('Dr Vijay changed their photo', { timeout: 15_000 });
  expect(await b.locator('.chat-hd [data-testid=avatar-photo]').getAttribute('src')).not.toBe(first);

  // "Nobody": Ravi's copy goes.
  await a.getByTestId('me-privacy').click();
  await a.getByTestId('photo-visibility').selectOption('nobody');
  await expect(b.locator('.chat-hd [data-testid=avatar-photo]')).toHaveCount(0, { timeout: 15_000 });
  await a.getByTestId('photo-visibility').selectOption('contacts');
  await expect(b.locator('.chat-hd [data-testid=avatar-photo]')).toBeVisible({ timeout: 15_000 });
  await a.getByTestId('back').click();

  // A group picture (admin): members see it in Groups.
  await tab(a, 'groups');
  await a.getByTestId('groups-new').click();
  await a.getByTestId('group-name-input').fill('Seva team');
  for (const box of await a.getByTestId('group-pick').all()) await box.check();
  await a.getByTestId('group-create').click();
  await b.getByTestId('chat-back').click();
  await tab(b, 'groups');
  await b.getByTestId('group-join').click({ timeout: 20_000 });
  await expect(b.getByTestId('peer-name')).toHaveText('Seva team');
  await b.getByTestId('chat-back').click();
  await a.getByTestId('group-info-open').click();
  await choosePhoto(a, () => a.getByTestId('group-photo').click(), await jpegWithExif(a, 120));
  await expect(b.getByTestId('group').getByTestId('avatar-photo')).toBeVisible({ timeout: 20_000 });
  await b.screenshot({ path: 'docs/screens/360-photo-groups.png' });

  // Never to the relays: no event the relay stored is big enough to hold a picture (it saw every event).
  expect(Math.max(0, ...relay.events.map((e) => JSON.stringify(e).length))).toBeLessThan(8000);
  people.onlyLocal();
});
