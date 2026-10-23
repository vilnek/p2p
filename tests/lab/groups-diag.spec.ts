import { expect, test, type Page } from '@playwright/test';
import { Lab, fragment, join, makeInvite, metric, openContact, say, tab } from './lab';
import { startLabRelay, type LabRelay } from './lab-relay';

// TEST LAB · diagnosis for the group catch-up failure: (1) is a just-joined group kept if the app
// closes at once? (2) does an offline member get missed messages once connected again?
/** Group invites and groups: the Groups tab where the app has one (from 23 Oct), else Chats. */
async function groupsTab(p: Page): Promise<void> {
  if (await p.getByTestId('tab-groups').count()) await p.getByTestId('tab-groups').click();
  else await tab(p, 'chats');
}

let relay: LabRelay;
let lab: Lab;
test.beforeEach(async ({ browser }) => {
  relay = await startLabRelay();
  lab = new Lab(browser, () => relay);
});
test.afterEach(async () => {
  await lab.close();
  await relay.stop();
});

async function trio(gname: string) {
  const A = await lab.person('Dr Vijay');
  const out: { ctx: import('@playwright/test').BrowserContext; page: Page }[] = [];
  for (const name of ['Ravi', 'Meera']) {
    const link = await makeInvite(A.page);
    const ctx = await lab.context();
    const p = await lab.page(ctx, name);
    await p.goto(`${lab.q()}${fragment(link)}`);
    await join(p, name);
    await expect(p.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 30_000 });
    out.push({ ctx, page: p });
  }
  await tab(A.page, 'add');
  await A.page.getByTestId('new-group').click();
  await A.page.getByTestId('group-name-input').fill(gname);
  for (const box of await A.page.getByTestId('group-pick').all()) await box.check();
  await A.page.getByTestId('group-create').click();
  for (const m of out) {
    await groupsTab(m.page);
    await m.page.getByTestId('group-join').click({ timeout: 30_000 });
    await expect(m.page.getByTestId('peer-name')).toHaveText(gname);
  }
  return { a: A.page, b: out[0], c: out[1] };
}
const groupListed = async (p: Page, gname: string) => {
  await groupsTab(p);
  await p.waitForTimeout(1500);
  return p.getByTestId('group').filter({ hasText: gname }).count();
};

for (const waitMs of [0, 5000]) {
  test(`a group joined ${waitMs / 1000} s before the app closes is still there after reopening`, async () => {
    const { c } = await trio('Kept');
    await c.page.waitForTimeout(waitMs);
    await c.page.close();
    const back = await lab.page(c.ctx, 'Meera-back');
    await back.goto(lab.q());
    const n = await groupListed(back, 'Kept');
    metric(`group-kept-after-close-${waitMs}ms`, { listed: n });
    expect(n).toBe(1);
  });
}

test('offline member catch-up: who reconnects, and how long until missed messages arrive', async () => {
  test.setTimeout(10 * 60_000);
  const { a, c } = await trio('Catch');
  await c.page.waitForTimeout(3000);
  await c.page.close();
  await say(a, 'missed one');
  await say(a, 'missed two');
  await a.waitForTimeout(2000);
  const back = await lab.page(c.ctx, 'Meera-back');
  await back.goto(lab.q());
  await openContact(back, 'Dr Vijay');
  await expect(back.getByTestId('presence')).toHaveText('online', { timeout: 40_000 });
  const t0 = Date.now();
  await groupsTab(back);
  await back.getByTestId('group').filter({ hasText: 'Catch' }).first().click();
  let got = false;
  try {
    await expect(back.getByTestId('gmsg-them').filter({ hasText: 'missed two' })).toHaveCount(1, { timeout: 120_000 });
    got = true;
  } catch {}
  // Does a NEW message reach her now that she is connected?
  await say(a, 'new after back');
  let fresh = false;
  try {
    await expect(back.getByTestId('gmsg-them').filter({ hasText: 'new after back' })).toHaveCount(1, { timeout: 30_000 });
    fresh = true;
  } catch {}
  const shown = await back.getByTestId('gmsg-them').allTextContents();
  metric('group-catch-up-diag', { missedArrived: got, seconds: (Date.now() - t0) / 1000, newArrived: fresh, shown });
  expect({ got, fresh }).toEqual({ got: true, fresh: true });
});
