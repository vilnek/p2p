import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { CONNECTED, expectPeerId, join, makeAccount, myId, pathLabel, SAME_WIFI, tab } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// One-scan connect through a LOCAL mock relay only (never the real public relays).

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

/** Any network use other than this page and the local relay fails the test. */
function guard(page: Page, seen: string[]): void {
  page.on('request', (r) => seen.push(r.url()));
  page.on('websocket', (ws) => seen.push(ws.url()));
}
function onlyLocal(seen: string[]): void {
  const outside = seen.filter((u) => !/^(http:\/\/127\.0\.0\.1:4318\/(p2p\.html([?#].*)?|favicon\.ico)|ws:\/\/127\.0\.0\.1:\d+\/?)$/.test(u));
  expect(outside).toEqual([]);
}

async function person(browser: Browser, name: string, url: string, seen: string[]): Promise<{ page: Page; id: string }> {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  const page = await ctx.newPage();
  guard(page, seen);
  page.on('pageerror', (e) => console.log(name, 'pageerror', e.message));
  await page.goto(url);
  await makeAccount(page, name);
  const id = await myId(page);
  return { page, id };
}

const q = () => `/p2p.html?relays=${encodeURIComponent(relay.url)}`;

async function showCard(a: Page): Promise<string> {
  await tab(a, 'add');
  await a.getByTestId('show-my-code').click();
  await expect(a.getByTestId('waiting-scan')).toBeVisible({ timeout: 15_000 });
  await a.getByTestId('toggle-text').click();
  const link = await a.getByTestId('code-text').inputValue();
  expect(link).toMatch(/^https:\/\/p2p\.vilnek\.in\/#c=[A-Za-z0-9_-]+$/);
  return link;
}

async function paste(b: Page, text: string): Promise<void> {
  await tab(b, 'add');
  await b.getByTestId('paste-their-code').click();
  await b.getByTestId('paste-box').fill(text);
  await b.getByTestId('paste-go').click();
}

test('one scan: A shows a small code, B pastes it, they connect, chat and call', async ({ browser }) => {
  const seen: string[] = [];
  const A = await person(browser, 'Asha', q(), seen);
  const B = await person(browser, 'Ravi', q(), seen);
  const link = await showCard(A.page);
  const payload = link.split('#c=')[1];
  console.log(`connect card: ${payload.length} characters (+ ${link.length - payload.length} for the link part; this test's card also carries the local relay address)`);

  // "Connecting…" can be very brief, so record whether it appeared on each side.
  for (const p of [A.page, B.page]) {
    await p.evaluate(() => {
      const w = window as unknown as { __sawConnecting: boolean };
      w.__sawConnecting = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid=connecting]')) w.__sawConnecting = true;
      }).observe(document.body, { subtree: true, childList: true });
    });
  }
  await paste(B.page, link);
  await expectPeerId(A.page, B.id, 30_000);
  await expectPeerId(B.page, A.id, 30_000);
  await expect(A.page.getByTestId('peer-name')).toHaveText('Ravi');
  await expect(B.page.getByTestId('peer-name')).toHaveText('Asha');
  for (const p of [A.page, B.page]) expect(await p.evaluate(() => (window as unknown as { __sawConnecting: boolean }).__sawConnecting)).toBe(true);
  await expect(A.page.getByTestId('presence')).toHaveText('online');
  await expect.poll(() => pathLabel(A.page), { timeout: 20_000 }).toBe(SAME_WIFI);

  // Chat both ways.
  await A.page.getByTestId('message-input').fill('One scan works');
  await A.page.getByTestId('send').click();
  await expect(B.page.getByTestId('msg-them')).toHaveText(/One scan works/);
  await B.page.getByTestId('message-input').fill('Yes it does');
  await B.page.getByTestId('send').click();
  await expect(A.page.getByTestId('msg-them')).toHaveText(/Yes it does/);

  // Call states still work.
  await B.page.getByTestId('video-call').click();
  await expect(B.page.getByTestId('call-status')).toHaveText('Ringing…');
  await A.page.getByTestId('accept').click();
  await expect(B.page.getByTestId('call-status')).toHaveText(CONNECTED, { timeout: 25_000 });
  await expect(A.page.getByTestId('call-status')).toHaveText(CONNECTED, { timeout: 25_000 });
  await B.page.getByTestId('hang-up').click();
  await expect(A.page.getByTestId('call-status')).toHaveText('Call ended');

  // What the relay saw: only ephemeral events with random tags and locked content.
  expect(relay.events.length).toBeGreaterThanOrEqual(2);
  for (const ev of relay.events) {
    expect(ev.kind).toBe(25050);
    expect(ev.tags[0][0]).toBe('t');
    expect(ev.tags[0][1]).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.content).not.toMatch(/P2P1|fingerprint|candidate|Asha|Ravi/);
    expect(ev.content).toMatch(/^[A-Za-z0-9_-]+$/);
  }
  // Throwaway Nostr keys are not the identity keys.
  const ids = [A.id, B.id].map((s) => s.replace(/ /g, ''));
  for (const ev of relay.events) expect(ids).not.toContain(ev.pubkey);
  onlyLocal(seen);
});

test('invite link: B opens the page with #c= and connects', async ({ browser }) => {
  const seen: string[] = [];
  const A = await person(browser, 'Asha', q(), seen);
  const link = await showCard(A.page);
  const payload = link.split('#c=')[1];

  const ctx = await browser.newContext();
  contexts.push(ctx);
  const b = await ctx.newPage();
  guard(b, seen);
  await b.goto(`${q()}#c=${payload}`);
  await join(b, 'Ravi'); // one screen, one button: the account is made and the link carries on
  await expectPeerId(b, A.id, 30_000);
  await expect(A.page.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 30_000 });
  await expect(b).toHaveURL(/\/p2p\.html\?relays=[^#]*$/); // the code is removed from the address bar
  onlyLocal(seen);
});

test('relay unreachable: falls back to two-step codes, which still connect', async ({ browser }) => {
  const seen: string[] = [];
  const dead = '/p2p.html?relays=' + encodeURIComponent('ws://127.0.0.1:9');
  const A = await person(browser, 'Asha', dead, seen);
  const B = await person(browser, 'Ravi', dead, seen);
  await tab(A.page, 'add');
  await A.page.getByTestId('show-my-code').click();
  await expect(A.page.getByTestId('fallback-note')).toContainText('two-step codes', { timeout: 15_000 });
  await A.page.getByTestId('toggle-text').click();
  const offer = await A.page.getByTestId('code-text').inputValue();
  expect(offer).toMatch(/^P2P1\./);
  await paste(B.page, offer);
  await expect(B.page.getByTestId('qr')).toBeVisible({ timeout: 15_000 });
  await B.page.getByTestId('toggle-text').click();
  const answer = await B.page.getByTestId('code-text').inputValue();
  await A.page.getByTestId('paste-reply').click();
  await A.page.getByTestId('paste-box').fill(answer);
  await A.page.getByTestId('paste-go').click();
  await expectPeerId(A.page, B.id);
  await expectPeerId(B.page, A.id);
  onlyLocal(seen);
});

test('the same code used a second time is refused', async ({ browser }) => {
  const seen: string[] = [];
  const A = await person(browser, 'Asha', q(), seen);
  const B = await person(browser, 'Ravi', q(), seen);
  const C = await person(browser, 'Chetan', q(), seen);
  const link = await showCard(A.page);
  await paste(B.page, link);
  await expectPeerId(B.page, A.id, 30_000);

  // A third device tries the same code: A's side refuses it.
  await paste(C.page, link);
  await expect(C.page.getByTestId('error')).toHaveText('This code was already used. Ask them to show a new one.', { timeout: 20_000 });
  // A stays connected to B.
  await expectPeerId(A.page, B.id);

  // B trying it again on its own device is refused at once.
  await B.page.goto(q());
  await paste(B.page, link);
  await expect(B.page.getByTestId('error')).toHaveText('This code was already used. Ask them to show a new one.');
  onlyLocal(seen);
});
