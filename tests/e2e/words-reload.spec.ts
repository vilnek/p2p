import { expect, test } from '@playwright/test';
import { People } from './fixtures';
import { doneWords, revealWords, tab } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// Make my account, then close the page before the 3-word check: the account exists, so the 24 words
// must not be lost. They are offered again from the "Save your 24 words" banner until the check passes.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

test('make account, reload before the check: the same 24 words come back from the banner, then it goes', async () => {
  const p = await people.page(undefined, 'Ravi');
  await p.goto(people.q());
  await p.getByTestId('name').fill('Ravi');
  await p.getByTestId('make-account').click();
  const words = await revealWords(p);
  await p.reload();
  await expect(p.getByTestId('tab-chats')).toBeVisible();
  await expect(p.getByTestId('save-words-banner')).toBeVisible();
  await p.getByTestId('save-words-banner').click();
  const again = await revealWords(p);
  expect(again).toBe(words);
  await p.getByTestId('phrase-done').click();
  const list = words.split(' ');
  for (const box of await p.getByTestId('check-word').all()) await box.fill(list[Number(await box.getAttribute('data-n')) - 1]);
  await p.getByTestId('words-check-go').click();
  await expect(p.getByTestId('save-words-banner')).toHaveCount(0);
  await p.reload();
  await expect(p.getByTestId('tab-chats')).toBeVisible();
  await expect(p.getByTestId('save-words-banner')).toHaveCount(0);
  // Finishing the check the normal way (no reload) stores nothing either.
  const q = await people.page(undefined, 'Asha');
  await q.goto(people.q());
  await q.getByTestId('make-account').click();
  await doneWords(q);
  await tab(q, 'me');
  await expect(q.getByTestId('save-words-banner')).toHaveCount(0);
  people.onlyLocal();
});
