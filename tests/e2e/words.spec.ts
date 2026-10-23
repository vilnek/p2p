import { expect, test } from '@playwright/test';
import { People } from './fixtures';
import { revealWords } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// The 24 words are never visible by default: a frosted cover, hold to show (gone on release, after
// 30 s, and when the app goes to the background), Copy with a clipboard clear, and a 3-word check.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

test('24 words: covered, hold to show, hidden again (release, 30 s, background), Copy, then a 3-word check', async () => {
  const ctx = await people.context({ viewport: { width: 360, height: 740 }, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await people.page(ctx, 'phone');
  await p.clock.install();
  await p.goto(people.q());
  await p.getByTestId('name').fill('Ravi');
  await p.getByTestId('make-account').click();
  await expect(p.getByTestId('words-cover')).toHaveText('Tap and hold to show your 24 words');
  await expect(p.getByTestId('phrase')).toHaveCount(0);
  await p.screenshot({ path: 'docs/screens/360-words-covered.png' });
  const words = await revealWords(p); // shown only while held
  expect(words.split(' ')).toHaveLength(24);
  // Not anywhere else on the page (title, notes).
  expect(await p.title()).not.toContain(words.split(' ')[0] + ' ' + words.split(' ')[1]);
  // Held for 30 s: hidden by itself.
  await p.getByTestId('words-cover').dispatchEvent('pointerdown');
  await expect(p.getByTestId('phrase').locator('li')).toHaveCount(24);
  await p.clock.runFor(30_500);
  await expect(p.getByTestId('phrase')).toHaveCount(0);
  await p.getByTestId('words-cover').dispatchEvent('pointerup');
  // The app going to the background hides them.
  await p.getByTestId('words-cover').dispatchEvent('pointerdown');
  await expect(p.getByTestId('phrase').locator('li')).toHaveCount(24);
  await p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(p.getByTestId('phrase')).toHaveCount(0);
  await p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });
  // Copy: the words on the clipboard, then cleared after a minute.
  await p.getByTestId('words-copy').click();
  await expect(p.getByTestId('words-copied')).toContainText('cleared in 1 minute');
  expect(await p.evaluate(() => navigator.clipboard.readText())).toBe(words);
  await p.clock.runFor(61_000);
  await expect.poll(() => p.evaluate(() => navigator.clipboard.readText())).toBe('');
  // "I've written them down": three words back; a wrong one is refused.
  await p.getByTestId('phrase-done').click();
  const boxes = await p.getByTestId('check-word').all();
  expect(boxes).toHaveLength(3);
  const list = words.split(' ');
  const ns = await Promise.all(boxes.map(async (b) => Number(await b.getAttribute('data-n'))));
  expect(new Set(ns).size).toBe(3);
  await p.screenshot({ path: 'docs/screens/360-words-check.png' }); // empty boxes: no words in the picture
  for (const [i, b] of boxes.entries()) await b.fill(i === 2 ? 'wrong' : list[ns[i] - 1]);
  await p.getByTestId('words-check-go').click();
  await expect(p.getByTestId('words-check-error')).toContainText('doesn’t match');
  await boxes[2].fill(list[ns[2] - 1].toUpperCase()); // case doesn't matter
  await p.getByTestId('words-check-go').click();
  await expect(p.getByTestId('tab-chats')).toBeVisible();
  await expect(p.locator('body')).not.toContainText(words.split(' ').slice(0, 3).join(' '));
});
