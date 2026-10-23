import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { join, makeAccount, pathLabel, SAME_WIFI, tab } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// 24-hour invite links through a LOCAL mock relay only (never the real public relays).

const USED = 'This invite has expired or was already used. Ask for a new one.';
const SENT = "✓ Request sent to Dr Vijay. You'll connect when they're online.";

let relay: MockRelay;
test.beforeAll(async () => {
  relay = await startMockRelay();
});
test.afterAll(async () => {
  await relay.close();
});

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});

let seen: string[] = [];
test.beforeEach(() => {
  seen = [];
});
function guard(page: Page): void {
  page.on('request', (r) => seen.push(r.url()));
  page.on('websocket', (ws) => seen.push(ws.url()));
  page.on('pageerror', (e) => console.log('pageerror', e.message));
}
function onlyLocal(): void {
  const outside = seen.filter((u) => !/^(http:\/\/127\.0\.0\.1:4318\/(p2p\.html([?#].*)?|favicon\.ico)|ws:\/\/127\.0\.0\.1:\d+\/?)$/.test(u));
  expect(outside).toEqual([]);
}

const q = (extra = '') => `/p2p.html?relays=${encodeURIComponent(relay.url)}${extra}`;

async function newContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  return ctx;
}

async function account(page: Page, name: string): Promise<void> {
  await makeAccount(page, name);
}

async function person(browser: Browser, name: string, url = q()): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  guard(page);
  await page.goto(url);
  await account(page, name);
  return { ctx, page };
}

async function makeInvite(page: Page): Promise<string> {
  await tab(page, 'add');
  await page.getByTestId('share-invite').click();
  await page.getByTestId('make-invite').click();
  const link = await page.getByTestId('invite-link').inputValue();
  expect(link).toMatch(/^https:\/\/p2p\.vilnek\.in\/#c=[A-Za-z0-9_-]+$/);
  return link;
}

/** B opens the invite link in a fresh browser profile (making an account first). */
async function openInvite(browser: Browser, link: string, name: string, extra = ''): Promise<Page> {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  guard(page);
  await page.goto(`${q(extra)}#c=${link.split('#c=')[1]}`);
  await join(page, name);
  return page;
}

test('sender offline, invitee still online when the sender returns: connects straight away and chats', async ({ browser }) => {
  const A = await person(browser, 'Dr Vijay');
  const link = await makeInvite(A.page);
  console.log(`invite link: ${link.length} characters (payload ${link.split('#c=')[1].length}, incl. the local test relay address and the name)`);
  await A.page.close(); // the sender goes offline

  const b = await openInvite(browser, link, 'Ravi');
  await expect(b.getByTestId('invite-status')).toHaveText('Connecting to Dr Vijay…');
  await expect(b.getByTestId('invite-status')).toHaveText(SENT, { timeout: 25_000 });
  expect(relay.stored().length).toBeGreaterThanOrEqual(1); // the locked request waits on the relay
  for (const ev of relay.stored()) {
    expect(ev.kind).toBe(30078);
    expect(Number(ev.tags.find((t) => t[0] === 'expiration')![1])).toBeGreaterThan(Date.now() / 1000);
    expect(ev.content).not.toMatch(/Ravi|Vijay|P2P1/);
  }

  // The sender comes back while Ravi is still online: they connect straight away, no Accept / Block
  // (Dr Vijay, 22 Oct 2026: "Connect straight away if they are still online").
  const a = await A.ctx.newPage();
  guard(a);
  await a.goto(q());
  await expect(a.getByTestId('accept-request')).toHaveCount(0);

  await expect(b.getByTestId('success-note')).toHaveText('Connected', { timeout: 30_000 });
  await expect(a.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 30_000 });
  await expect(b.getByTestId('presence')).toHaveText('online');
  await expect.poll(() => pathLabel(b), { timeout: 20_000 }).toBe(SAME_WIFI);

  await a.getByTestId('message-input').fill('Welcome Ravi');
  await a.getByTestId('send').click();
  await expect(b.getByTestId('msg-them')).toHaveText(/Welcome Ravi/);
  await b.getByTestId('message-input').fill('Thank you');
  await b.getByTestId('send').click();
  await expect(a.getByTestId('msg-them')).toHaveText(/Thank you/);
  onlyLocal();
});

test('both offline in turn: sender sees Accept / Block once, then they connect directly', async ({ browser }) => {
  const A = await person(browser, 'Dr Vijay');
  const link = await makeInvite(A.page);
  await A.page.close(); // sender offline

  const B = await openInvite(browser, link, 'Ravi');
  await expect(B.getByTestId('invite-status')).toHaveText(SENT, { timeout: 25_000 });
  const bCtx = B.context();
  await B.close(); // the invitee goes offline too

  // The sender comes back: Ravi is offline, so Accept / Block is shown (only this once).
  const a = await A.ctx.newPage();
  guard(a);
  await a.goto(q());
  await expect(a.getByTestId('request-text')).toHaveText('Ravi joined from your invite', { timeout: 20_000 });
  await a.getByTestId('accept-request').click();

  // Ravi comes back: the acceptance is waiting; they connect and chat directly.
  const b = await bCtx.newPage();
  guard(b);
  await b.goto(q());
  await expect(b.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 30_000 });
  await a.getByTestId('message-input').fill('Accepted once, direct from now on');
  await a.getByTestId('send').click();
  await expect(b.getByTestId('msg-them')).toHaveText(/direct from now on/);
  onlyLocal();
});

test('sender online: the link connects directly within seconds', async ({ browser }) => {
  const A = await person(browser, 'Dr Vijay');
  const link = await makeInvite(A.page);
  const started = Date.now();
  const b = await openInvite(browser, link, 'Ravi');
  await expect(b.getByTestId('success-note')).toHaveText('Connected', { timeout: 20_000 });
  console.log(`direct connect after opening the link: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await expect(A.page.getByTestId('joined-note')).toHaveText('Ravi joined from your invite');
  await expect(A.page.getByTestId('peer-name')).toHaveText('Ravi');
  onlyLocal();
});

test('expired invite shows the expired message', async ({ browser }) => {
  const A = await person(browser, 'Dr Vijay', q('&inviteTtl=-300')); // test flag: already expired
  const link = await makeInvite(A.page);
  const b = await openInvite(browser, link, 'Ravi');
  await expect(b.getByTestId('error')).toHaveText(USED);
  onlyLocal();
});

test('a used invite opened by a third person shows the used message', async ({ browser }) => {
  const A = await person(browser, 'Dr Vijay');
  const link = await makeInvite(A.page);
  const b = await openInvite(browser, link, 'Ravi');
  await expect(b.getByTestId('success-note')).toHaveText('Connected', { timeout: 20_000 });
  const c = await openInvite(browser, link, 'Chetan');
  await expect(c.getByTestId('invite-status')).toHaveText(USED, { timeout: 20_000 });
  await expect(A.page.getByTestId('peer-name')).toHaveText('Ravi'); // A stays with Ravi
  onlyLocal();
});

test('contacts persist after reload, Connect works, and offline is reported', async ({ browser }) => {
  const A = await person(browser, 'Dr Vijay');
  const link = await makeInvite(A.page);
  const b = await openInvite(browser, link, 'Ravi');
  await expect(b.getByTestId('success-note')).toHaveText('Connected', { timeout: 20_000 });

  await A.page.goto(q());
  await b.goto(q());
  await expect(A.page.getByTestId('contact-name')).toHaveText('Ravi');
  await expect(b.getByTestId('contact-name')).toHaveText('Dr Vijay');
  await tab(A.page, 'add');
  await A.page.getByTestId('my-invites').click();
  await expect(A.page.getByTestId('invite-state')).toHaveText('Used by Ravi');

  await tab(A.page, 'chats');
  await A.page.getByTestId('contact').click();
  await expect(A.page.getByTestId('contact-status')).toHaveText('Connecting to Ravi…');
  await expect(A.page.getByTestId('success-note')).toHaveText('Connected', { timeout: 20_000 });
  await expect(b.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 20_000 });
  await A.page.getByTestId('message-input').fill('Hello again');
  await A.page.getByTestId('send').click();
  await expect(b.getByTestId('msg-them').last()).toHaveText(/Hello again/);

  // Ravi goes away: Connect reports offline after 8 s.
  await b.close();
  await A.page.goto(q());
  await A.page.getByTestId('contact').click();
  await expect(A.page.getByTestId('contact-status')).toHaveText('Ravi is offline · try again later', { timeout: 20_000 });
  onlyLocal();
});
