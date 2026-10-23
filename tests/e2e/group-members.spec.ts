import { expect, test, type Page } from '@playwright/test';
import { People, fragment, makeInvite } from './fixtures';
import { join, tab } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// Group members who are NOT each other's contacts (Ravi and Meera are contacts of Dr Vijay only)
// connect directly as "group member" links: their own pair secret bound to the group, through the
// relays (INTEGRATION_FILES_GROUPS.md §3.2). Such a link shows no chat in Chats. LOCAL mock relay only.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

async function trio(): Promise<{ a: Page; b: Page; c: Page }> {
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
  await expect(a.getByTestId('group-count')).toHaveText('3 members');
  for (const p of others) {
    await tab(p, 'groups');
    await p.getByTestId('group-join').click({ timeout: 20_000 });
    await expect(p.getByTestId('peer-name')).toHaveText('Seva team');
  }
  return { a, b: others[0], c: others[1] };
}

test('two members who are not contacts: a group message goes straight from one to the other (the admin is away)', async () => {
  const { a, b, c } = await trio();
  await a.close(); // nobody can carry it for them now
  await b.getByTestId('message-input').fill('Only Ravi to Meera');
  await b.getByTestId('send').click();
  await expect(c.getByTestId('gmsg-them').filter({ hasText: 'Only Ravi to Meera' })).toHaveCount(1, { timeout: 40_000 });
  await expect(c.getByTestId('gmsg-from').last()).toHaveText('Ravi');
  // And back.
  await c.getByTestId('message-input').fill('Hello Ravi');
  await c.getByTestId('send').click();
  await expect(b.getByTestId('gmsg-them').filter({ hasText: 'Hello Ravi' })).toHaveCount(1, { timeout: 20_000 });
  // A group-member link is not a contact: no chat with each other in Chats.
  for (const [p, other] of [[b, 'Meera'], [c, 'Ravi']] as const) {
    await tab(p, 'chats');
    await p.waitForTimeout(500);
    await expect(p.getByTestId('contact').filter({ hasText: other })).toHaveCount(0);
  }
  people.onlyLocal();
});

test('a group voice call with all three: every pair connects, also the two who are not contacts', async () => {
  const { a, b, c } = await trio();
  await b.getByTestId('group-voice-call').click(); // Ravi calls: Meera is not his contact
  for (const p of [a, c]) {
    await expect(p.getByTestId('gcall-title')).toHaveText('Ravi is calling Seva team', { timeout: 30_000 });
    await p.getByTestId('gcall-join').click();
  }
  for (const p of [a, b, c]) {
    await expect(p.getByTestId('gcall-tile')).toHaveCount(3, { timeout: 40_000 });
    await expect(p.locator('[data-testid=gcall-tile][data-state=connected]')).toHaveCount(2, { timeout: 45_000 });
  }
  await b.getByTestId('gcall-leave').click();
  await expect(b.getByTestId('gcall-screen')).toHaveCount(0, { timeout: 10_000 });
  people.onlyLocal();
});
