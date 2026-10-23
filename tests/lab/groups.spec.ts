import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { Lab, fragment, join, makeInvite, metric, openContact, say, tab } from './lab';
import { startLabRelay, type LabRelay } from './lab-relay';

// TEST LAB · groups through the UI: 3 and 8 members, members passing messages on, an offline member
// catching up, and a member who left (or was removed, once the UI has it) not reading new messages.
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

const NAMES = ['Dr Vijay', 'Ravi', 'Meera', 'Chetan', 'Asha', 'Kiran', 'Neha', 'Arjun'];
interface Member {
  name: string;
  ctx: BrowserContext;
  page: Page;
}

/** The admin invites each other person by link (they become contacts), then makes the group; all join. */
async function makeGroup(n: number, gname: string): Promise<Member[]> {
  const A = await lab.person(NAMES[0]);
  const members: Member[] = [{ name: NAMES[0], ...A }];
  for (const name of NAMES.slice(1, n)) {
    const link = await makeInvite(A.page);
    const ctx = await lab.context();
    const p = await lab.page(ctx, name);
    await p.goto(`${lab.q()}${fragment(link)}`);
    await join(p, name);
    await expect(p.getByTestId('peer-name')).toHaveText(NAMES[0], { timeout: 30_000 });
    members.push({ name, ctx, page: p });
  }
  const a = A.page;
  await tab(a, 'add');
  await a.getByTestId('new-group').click();
  await a.getByTestId('group-name-input').fill(gname);
  for (const box of await a.getByTestId('group-pick').all()) await box.check();
  await a.getByTestId('group-create').click();
  await expect(a.getByTestId('group-count')).toHaveText(`${n} members`);
  for (const m of members.slice(1)) {
    await groupsTab(m.page);
    await expect(m.page.getByTestId('group-invite-text')).toHaveText(`${NAMES[0]} added you to ${gname}`, { timeout: 30_000 });
    await m.page.getByTestId('group-join').click();
    await expect(m.page.getByTestId('peer-name')).toHaveText(gname);
  }
  return members;
}

async function openGroup(p: Page, gname: string): Promise<void> {
  await groupsTab(p);
  try {
    await p.getByTestId('group').filter({ hasText: gname }).first().click({ timeout: 30_000 });
  } catch (e) {
    const list = await p.locator('[aria-label=List], .list, main').first().innerText().catch(() => '?');
    throw new Error(`group "${gname}" not in the Groups list. The list shows: ${list.replace(/\s+/g, ' ').slice(0, 600)}`);
  }
  await expect(p.getByTestId('peer-name')).toHaveText(gname);
}

/** Is this text anywhere in the page's IndexedDB (every database, every store)? */
const storedHas = (p: Page, text: string) =>
  p.evaluate(async (text) => {
    let hit = false;
    for (const d of await indexedDB.databases()) {
      const db = await new Promise<IDBDatabase>((r, j) => {
        const q = indexedDB.open(d.name!);
        q.onsuccess = () => r(q.result);
        q.onerror = () => j(q.error);
      });
      for (const s of db.objectStoreNames) {
        const all = await new Promise<unknown[]>((r) => {
          const q = db.transaction(s).objectStore(s).getAll();
          q.onsuccess = () => r(q.result);
          q.onerror = () => r([]);
        });
        if (JSON.stringify(all).includes(text)) hit = true;
      }
      db.close();
    }
    return hit;
  }, text);

const gotIt = (p: Page, text: string, timeout = 30_000) => expect(p.getByTestId('gmsg-them').filter({ hasText: text })).toHaveCount(1, { timeout });

for (const n of [3, 8]) {
  test(`${n}-member group: everyone gets the admin's message and a member's message (passed on), once`, async () => {
    test.setTimeout(10 * 60_000);
    const ms = await makeGroup(n, `Seva ${n}`);
    let t0 = Date.now();
    await say(ms[0].page, `from admin ${n}`);
    for (const m of ms.slice(1)) await gotIt(m.page, `from admin ${n}`);
    const adminS = (Date.now() - t0) / 1000;
    // The last member is connected only to the admin: the admin passes it on.
    t0 = Date.now();
    const last = ms.at(-1)!;
    await say(last.page, `from ${last.name}`);
    for (const m of ms.slice(0, -1)) await gotIt(m.page, `from ${last.name}`);
    const memberS = (Date.now() - t0) / 1000;
    await expect(ms[1].page.getByTestId('gmsg-from').last()).toHaveText(last.name);
    await ms[0].page.getByTestId('group-info-open').click();
    await expect(ms[0].page.getByTestId('group-member')).toHaveCount(n);
    metric(`group-${n}`, { adminMsgAllS: adminS, memberMsgAllS: memberS });
    expect(lab.errors).toEqual([]);
  });
}

for (const n of [3, 8])
test(`${n}-member group: a member offline while messages are sent catches up when back`, async () => {
  test.setTimeout(12 * 60_000);
  const ms = await makeGroup(n, 'Catch up');
  const c = ms[2];
  await c.page.close(); // Meera goes offline
  for (let i = 1; i <= 3; i++) await say(ms[0].page, `while away ${i}`);
  await say(ms[1].page, 'Ravi while away');
  await ms[0].page.waitForTimeout(2000);
  const t0 = Date.now();
  const back = await lab.page(c.ctx, 'Meera-back');
  await back.goto(lab.q());
  // Coming back: open the chat with the admin (connects), then the group.
  await openContact(back, NAMES[0]);
  await expect(back.getByTestId('presence')).toHaveText('online', { timeout: 40_000 });
  await openGroup(back, 'Catch up');
  for (const t of ['while away 1', 'while away 2', 'while away 3', 'Ravi while away']) await gotIt(back, t, 60_000);
  metric(`group-${n}-offline-catch-up`, { caughtUpS: (Date.now() - t0) / 1000 });
});

test('3-member group: a member who left cannot read new messages; the others still can', async () => {
  test.setTimeout(8 * 60_000);
  const ms = await makeGroup(3, 'Leavers');
  const c = ms[2];
  await openGroup(c.page, 'Leavers');
  c.page.once('dialog', (d) => d.accept());
  await c.page.getByTestId('group-info-open').click();
  await c.page.getByTestId('group-leave').click();
  await expect(ms[0].page.getByTestId('group-count')).toHaveText('2 members', { timeout: 30_000 });
  await say(ms[0].page, 'after leave secret');
  await gotIt(ms[1].page, 'after leave secret');
  await c.page.waitForTimeout(8000);
  // Meera: not on screen, and not anywhere in her stored data.
  const visible = await c.page.getByText('after leave secret').count();
  const stored = await storedHas(c.page, 'after leave secret');
  metric('group-left-member', { visible, stored });
  expect(visible).toBe(0);
  expect(stored).toBe(false);
});

test('3-member group: a removed member cannot read new messages (Remove in the group details)', async () => {
  test.setTimeout(8 * 60_000);
  const ms = await makeGroup(3, 'Removal');
  const c = ms[2];
  await openGroup(c.page, 'Removal');
  await ms[0].page.getByTestId('group-info-open').click();
  const row = ms[0].page.getByTestId('group-member').filter({ hasText: c.name });
  ms[0].page.once('dialog', (d) => d.accept());
  await row.getByTestId('group-remove').click();
  await expect(ms[0].page.getByTestId('group-member')).toHaveCount(2, { timeout: 30_000 });
  await ms[0].page.keyboard.press('Escape');
  await say(ms[0].page, 'after removal secret');
  await gotIt(ms[1].page, 'after removal secret');
  await say(ms[1].page, 'member after removal');
  await gotIt(ms[0].page, 'member after removal');
  await c.page.waitForTimeout(8000);
  const visible = await c.page.getByText(/after removal|member after removal/).count();
  const stored = await storedHas(c.page, 'after removal');
  metric('group-removed-member', { visible, stored });
  expect(visible).toBe(0);
  expect(stored).toBe(false);
});

test('8-member group, admin closes the app: a member\'s message still reaches the other 6 (they are not contacts)', async () => {
  test.setTimeout(12 * 60_000);
  const ms = await makeGroup(8, 'No admin');
  // Let members find each other (non-contact member links).
  await ms[1].page.waitForTimeout(8000);
  await ms[0].page.close();
  const t0 = Date.now();
  await say(ms[1].page, 'without the admin');
  let got = 0;
  for (const m of ms.slice(2)) {
    try {
      await gotIt(m.page, 'without the admin', 60_000);
      got++;
    } catch {}
  }
  metric('group-8-admin-away', { reached: `${got}/6`, seconds: (Date.now() - t0) / 1000 });
  expect(got).toBe(6);
});

test('4-member group video call, started by a member: every pair connects (non-contacts too)', async () => {
  test.setTimeout(10 * 60_000);
  const ms = await makeGroup(4, 'Call four');
  const t0 = Date.now();
  await ms[1].page.getByTestId('group-video-call').click();
  for (const m of [ms[0], ms[2], ms[3]]) {
    await expect(m.page.getByTestId('gcall-title')).toContainText('Call four', { timeout: 30_000 });
    await m.page.getByTestId('gcall-join').click();
  }
  const per: number[] = [];
  for (const m of ms) {
    await expect(m.page.getByTestId('gcall-tile')).toHaveCount(4, { timeout: 45_000 });
    try {
      await expect(m.page.locator('[data-testid=gcall-tile][data-state=connected]')).toHaveCount(3, { timeout: 60_000 });
    } catch {}
    per.push(await m.page.locator('[data-testid=gcall-tile][data-state=connected]').count());
  }
  metric('group-call-4', { connectedPerMember: per, seconds: (Date.now() - t0) / 1000 });
  expect(per).toEqual([3, 3, 3, 3]);
});
