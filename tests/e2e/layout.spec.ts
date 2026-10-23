import { expect, test, type Locator, type Page } from '@playwright/test';
import { People, fragment, makeInvite } from './fixtures';
import { CONNECTED, confirmLink, join, makeAccount, tab } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// Layout checks for design P2 at phone sizes and on a wide screen, plus screenshots of each main
// screen into docs/screens/ to compare with the approved design.
// LOCAL mock relay only.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

const LONG = 'Dr Vijaykumar Katariya, Vilnek Founder'; // 38 characters (names stop at 40)
const shot = (p: Page, name: string) => p.screenshot({ path: `docs/screens/${name}.png` });

async function noSideScroll(p: Page, where: string): Promise<void> {
  const r = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, bw: document.body.scrollWidth }));
  expect(Math.max(r.sw, r.bw), `horizontal scroll on ${where}`).toBeLessThanOrEqual(r.w);
}

/** One line: the element's content is no taller than about one line. */
async function oneLine(l: Locator, what: string): Promise<void> {
  const r = await l.evaluate((el) => ({ h: el.scrollHeight, lh: parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.3 }));
  expect(r.h, `${what} on one line`).toBeLessThanOrEqual(Math.ceil(r.lh * 1.4));
}

/** No two of these boxes overlap. */
async function noOverlap(p: Page, selectors: string[], where: string): Promise<void> {
  const boxes = await p.evaluate((sels) => sels.map((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    return { s, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  }), selectors);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap = a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      expect(overlap, `${a.s} overlaps ${b.s} on ${where}`).toBe(false);
    }
}

for (const [w, h] of [[390, 844], [360, 740], [320, 640]] as const) {
  test(`phone ${w}×${h}: welcome, tabs, chat header, info sheet, calls`, async () => {
    const tag = `${w}`;
    const ctx = await people.context({ viewport: { width: w, height: h }, hasTouch: true });
    const p = await people.page(ctx, 'phone');
    await p.goto(people.q());
    await expect(p.getByTestId('make-account')).toBeVisible();
    // Welcome = the home page (design P3): top bar, title, the create-account card; nothing overlaps.
    await noOverlap(p, ['.hm-brand', '[data-testid=restore]', '[data-testid=home-open]'], `home top bar ${tag}`);
    await noOverlap(p, ['[data-testid=home-title]', '[data-testid=home-create]', '[data-testid=name]', '[data-testid=make-account]', '[data-testid=terms]'], `welcome ${tag}`);
    await noSideScroll(p, `welcome ${tag}`);
    if (w === 360) await shot(p, `360-welcome`);
    await makeAccount(p, 'Ravi');
    await expect(p.locator('.nav')).toBeVisible();
    // The floating glass tab bar: inset from the sides and the bottom, ~64 px tall.
    const tabsBox = (await p.locator('.nav').boundingBox())!;
    expect(tabsBox.height).toBeGreaterThanOrEqual(60);
    expect(tabsBox.x).toBeGreaterThanOrEqual(8);
    expect(tabsBox.x + tabsBox.width).toBeLessThanOrEqual(w - 8);
    expect(tabsBox.y + tabsBox.height).toBeLessThanOrEqual(h - 6);
    // Five tabs (Chats · Groups · Calls · Add · Me), each label whole on one line, also at 320 px.
    await expect(p.locator('.nav .tabb')).toHaveCount(5);
    expect(await p.locator('.nav .tabb .tl').allTextContents()).toEqual(['Chats', 'Groups', 'Calls', 'Add', 'Me']);
    for (const l of await p.locator('.nav .tabb .tl').all()) {
      const r = await l.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, h: el.getBoundingClientRect().height }));
      expect(r.sw, `tab label fits at ${tag}`).toBeLessThanOrEqual(r.cw + 1);
      expect(r.h).toBeLessThan(20);
    }
    for (const t of ['chats', 'groups', 'calls', 'add', 'me'] as const) {
      await tab(p, t);
      await noSideScroll(p, `${t} ${tag}`);
      if (w === 360) await shot(p, `360-${t}`);
    }

    // A partner on a computer invites me; I'm connected and in the chat.
    const A = await people.person(LONG);
    const link = await makeInvite(A.page);
    await p.goto(`${people.q()}${fragment(link)}`);
    await confirmLink(p);
    await expect(p.getByTestId('peer-name')).toHaveText(LONG, { timeout: 20_000 });
    await p.getByTestId('message-input').fill('Namaste!');
    await p.getByTestId('send').click();
    await A.page.getByTestId('message-input').fill('How are you? This message is a bit longer, to see how a bubble wraps on a small phone.');
    await A.page.getByTestId('send').click();
    await expect(p.getByTestId('msg-them')).toBeVisible();

    // The header: one row, fixed height; name and status one line each; nothing else in it.
    const head = (await p.locator('.chat-hd').boundingBox())!;
    expect(head.height).toBeLessThanOrEqual(64);
    await oneLine(p.getByTestId('peer-name'), 'name');
    await oneLine(p.getByTestId('presence'), 'status');
    await expect(p.locator('.chat-hd [data-testid=peer-id], .chat-hd .pics, .chat-hd [data-testid=path]')).toHaveCount(0);
    const send = (await p.getByTestId('send').boundingBox())!;
    expect(send.x + send.width).toBeLessThanOrEqual(w);
    expect(send.y + send.height).toBeLessThanOrEqual(h);
    await noSideScroll(p, `chat ${tag}`);
    if (w === 360) await shot(p, `360-chat`);
    // Offline: still one line, same height.
    await p.getByTestId('peer-info-open').click();
    await expect(p.getByTestId('peer-info')).toBeVisible();
    await noSideScroll(p, `info ${tag}`);
    if (w === 360) await shot(p, `360-info`);
    await p.keyboard.press('Escape');

    // Incoming video call, then connected: the control bar fully visible, the state one line.
    await A.page.getByTestId('video-call').click();
    await expect(p.getByTestId('call-status')).toHaveText('Video call', { timeout: 15_000 });
    await oneLine(p.getByTestId('call-status'), 'call state');
    if (w === 360) await shot(p, `360-incoming`);
    await p.getByTestId('accept').click();
    await expect(p.getByTestId('call-status')).toHaveText(CONNECTED, { timeout: 25_000 });
    const bar = (await p.locator('.ctrl').boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(0);
    expect(bar.x + bar.width).toBeLessThanOrEqual(w + 0.5);
    expect(bar.y + bar.height).toBeLessThanOrEqual(h);
    await oneLine(p.getByTestId('call-status'), 'call timer');
    await noSideScroll(p, `video call ${tag}`);
    if (w === 360) await shot(p, `360-video-call`);
    await p.getByTestId('hang-up').click();
    await expect(p.getByTestId('call-screen')).toHaveCount(0, { timeout: 10_000 }); // closes by itself

    // Voice call, ringing.
    await p.getByTestId('voice-call').click();
    await expect(p.getByTestId('call-status')).toHaveText('Ringing…', { timeout: 15_000 });
    await oneLine(p.getByTestId('call-status'), 'ringing');
    const vbar = (await p.locator('.ctrl').boundingBox())!;
    expect(vbar.x + vbar.width).toBeLessThanOrEqual(w + 0.5);
    if (w === 360) await shot(p, `360-voice-call`);
    await p.getByTestId('hang-up').click();
  });
}

test('wide 1280×800: rail · list · conversation · details; fixed header heights; call stage', async () => {
  const ctx = await people.context({ viewport: { width: 1280, height: 800 } });
  const p = await people.page(ctx, 'wide');
  await p.goto(people.q());
  await makeAccount(p, 'Ravi');
  // The empty state already follows P2: the rail and the list flush next to it.
  const [rail, list, convo] = await Promise.all(['.nav', '.list-pane', '.main-pane'].map(async (s) => (await p.locator(s).boundingBox())!));
  // Floating glass panels with small gaps: the rail (in its 72 px column), the list (in its 340 px column).
  expect(Math.round(rail.x)).toBe(12);
  expect(Math.round(rail.width)).toBe(56);
  expect(Math.round(list.x)).toBe(78);
  expect(Math.round(list.width)).toBe(328);
  expect(Math.round(convo.x)).toBe(412);
  await shot(p, '1280-empty');

  const A = await people.person(LONG);
  const link = await makeInvite(A.page);
  await p.goto(`${people.q()}${fragment(link)}`);
  await confirmLink(p);
  await expect(p.getByTestId('peer-name')).toHaveText(LONG, { timeout: 20_000 });
  await A.page.getByTestId('message-input').fill('Hello from the computer');
  await A.page.getByTestId('send').click();
  await expect(p.getByTestId('msg-them')).toBeVisible();
  for (const s of ['.nav', '.list-pane', '.main-pane', '.side-pane']) await expect(p.locator(s)).toBeVisible();
  await expect(p.getByTestId('peer-info')).toBeVisible(); // the details panel, not a sheet
  for (const s of ['.list-pane .hd', '.chat-hd']) expect(Math.round((await p.locator(s).boundingBox())!.height)).toBe(64);
  await oneLine(p.getByTestId('peer-name'), 'name');
  await noSideScroll(p, 'wide chat');
  await shot(p, '1280-chat');
  // The rail: Chats · Groups · Calls · Add · Me (Groups between Chats and Calls).
  expect(await p.locator('.nav .tabb').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual(['tab-chats', 'tab-groups', 'tab-calls', 'tab-add', 'tab-me']);
  for (const t of ['groups', 'calls', 'add', 'me'] as const) {
    await tab(p, t);
    await shot(p, `1280-${t}`);
  }
  await tab(p, 'chats');

  await A.page.getByTestId('video-call').click();
  await p.getByTestId('accept').click();
  await expect(p.getByTestId('call-status')).toHaveText(CONNECTED, { timeout: 25_000 });
  const stage = (await p.getByTestId('remote-video').boundingBox())!;
  expect(stage.x).toBeCloseTo(24, 0);
  expect(stage.width).toBeGreaterThan(800);
  await expect(p.locator('.tiles')).toBeVisible();
  const bar = (await p.locator('.ctrl').boundingBox())!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(800);
  await noSideScroll(p, 'wide call');
  await shot(p, '1280-video-call');
  await p.getByTestId('hang-up').click();
});

test('instant join screen at 360', async () => {
  const A = await people.person('Dr Vijay');
  const link = await makeInvite(A.page);
  const ctx = await people.context({ viewport: { width: 360, height: 740 }, hasTouch: true });
  const p = await people.page(ctx, 'phone');
  await p.goto(`${people.q()}${fragment(link)}`);
  await expect(p.getByTestId('join-title')).toHaveText('Dr Vijay invited you');
  await noOverlap(p, ['.brand', '[data-testid=join-title]', '[data-testid=name]', '[data-testid=join]', '[data-testid=join-guest]', '[data-testid=terms]'], 'join 360');
  await noSideScroll(p, 'join 360');
  await shot(p, '360-join');
  await join(p, 'Ravi');
  await expect(p.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 20_000 });
});
