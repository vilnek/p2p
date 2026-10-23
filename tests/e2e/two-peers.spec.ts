import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { closeCallInfo, closeInfo, CONNECTED, expectPeerId, makeAccount as newAccount, myId, openCallInfo, openInfo, SAME_WIFI, tab } from './helpers';

// Two separate browser profiles (contexts) open the built dist/p2p.html and talk directly.

async function makeAccount(page: Page, name: string): Promise<string> {
  await newAccount(page, name);
  return myId(page);
}

async function readCode(page: Page): Promise<string> {
  await page.getByTestId('toggle-text').click();
  const code = await page.getByTestId('code-text').inputValue();
  expect(code).toMatch(/^P2P1\./);
  return code;
}

interface Pair {
  ctxA: BrowserContext;
  ctxB: BrowserContext;
  a: Page;
  b: Page;
  idA: string;
  idB: string;
  requests: string[];
}

// No public relays in tests: point the app at a closed local port.
const NO_RELAY = 'relays=' + encodeURIComponent('ws://127.0.0.1:9');

async function connect(browser: Browser, query = ''): Promise<Pair> {
  const requests: string[] = [];
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  for (const p of [a, b]) {
    p.on('request', (r) => requests.push(r.url()));
    p.on('websocket', (ws) => requests.push(ws.url())); // two-step codes must not touch any relay
    p.on('pageerror', (e) => console.log('pageerror', e.message));
    await p.goto(`/p2p.html?${NO_RELAY}${query.replace('?', '&')}`);
  }
  const idA = await makeAccount(a, 'Asha');
  const idB = await makeAccount(b, 'Ravi');

  // A shows its code; B pastes it and gets a reply code; A pastes the reply.
  await tab(a, 'add');
  await a.getByTestId('two-step').click();
  await expect(a.getByTestId('qr')).toBeVisible({ timeout: 15_000 });
  const offer = await readCode(a);
  console.log('offer code length', offer.length);

  await tab(b, 'add');
  await b.getByTestId('paste-their-code').click();
  await b.getByTestId('paste-box').fill(offer);
  await b.getByTestId('paste-go').click();
  await expect(b.getByTestId('qr')).toBeVisible({ timeout: 15_000 });
  const answer = await readCode(b);
  console.log('reply code length', answer.length);

  await a.getByTestId('paste-reply').click();
  await a.getByTestId('paste-box').fill(answer);
  await a.getByTestId('paste-go').click();

  // Both screens show the other's 24-digit ID.
  await expectPeerId(a, idB);
  await expectPeerId(b, idA);
  return { ctxA, ctxB, a, b, idA, idB, requests };
}

/** Records every call state the page shows, in order. */
async function recordCallStates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __states: string[] };
    w.__states = [];
    new MutationObserver(() => {
      const s = document.querySelector('[data-testid=call-screen]')?.getAttribute('data-state');
      if (s && w.__states.at(-1) !== s) w.__states.push(s);
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
}
const callStates = (page: Page) => page.evaluate(() => (window as unknown as { __states: string[] }).__states);

async function remoteVideoArrives(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const v = document.querySelector('[data-testid=remote-video]') as HTMLVideoElement | null;
          const s = v?.srcObject as MediaStream | null;
          return !!s && s.getVideoTracks().length > 0 && s.getVideoTracks()[0].readyState === 'live' && v!.videoWidth > 0;
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
}

test('accounts, connect by text, chat, path, online/offline, video call, hang up', async ({ browser }) => {
  const { ctxA, ctxB, a, b, requests } = await connect(browser);

  // The header shows only the name and one status line; the checks are in the info sheet.
  await expect(a.getByTestId('peer-name')).toHaveText('Ravi');
  await expect(a.locator('.chat-hd [data-testid=peer-id], .chat-hd [data-testid=peer-emoji], .chat-hd [data-testid=path]')).toHaveCount(0);
  await expect(a.getByText(/Connected directly\. You:/)).toHaveCount(0);
  await expect(a.getByTestId('success-note')).toHaveText('Connected');
  await expect(a.getByTestId('success-note')).toHaveCount(1);

  // Online, and the path shows the same local network for two browsers on one machine.
  await expect(a.getByTestId('presence')).toHaveText('online');
  await expect(b.getByTestId('presence')).toHaveText('online');
  await openInfo(b);
  const emojiA = await b.getByTestId('peer-emoji').textContent();
  await expect(b.getByTestId('path-label')).toHaveText(SAME_WIFI, { timeout: 20_000 });
  await closeInfo(b);
  const sheet = await openInfo(a);
  const emojiB = await a.getByTestId('peer-emoji').textContent();
  expect(emojiA).not.toBe(emojiB);
  await expect(a.getByTestId('path-label')).toHaveText(SAME_WIFI, { timeout: 20_000 });
  await expect(a.getByTestId('path')).toContainText('Locked end to end');
  await expect(a.getByTestId('path')).toContainText('Key matches their ID');
  await expect(sheet).toContainText('inside the same network');
  await closeInfo(a);

  // Messages both ways.
  await a.getByTestId('message-input').fill('Namaste Ravi');
  await a.getByTestId('send').click();
  await expect(b.getByTestId('msg-them')).toHaveText(/Namaste Ravi/);
  await b.getByTestId('message-input').fill('Hello Asha');
  await b.getByTestId('message-input').press('Enter');
  await expect(a.getByTestId('msg-them')).toHaveText(/Hello Asha/);

  // Video call: reaching -> ringing -> (accept) -> connected.
  await recordCallStates(a);
  await a.getByTestId('video-call').click();
  await expect(b.getByTestId('call-status')).toHaveText('Video call');
  await expect(b.getByTestId('call-screen')).toContainText('Asha');
  await expect(a.getByTestId('call-status')).toHaveText('Ringing…');
  await b.getByTestId('accept').click();
  await expect(a.getByTestId('call-status')).toHaveText(CONNECTED, { timeout: 25_000 });
  await expect(b.getByTestId('call-status')).toHaveText(CONNECTED, { timeout: 25_000 });
  expect(await callStates(a)).toEqual(['reaching', 'ringing', 'connecting', 'connected']);
  await openCallInfo(a);
  await expect(a.getByTestId('call-path')).toContainText(SAME_WIFI);
  await expect(a.getByTestId('call-emoji')).toContainText(emojiB!.trim());
  await closeCallInfo(a);
  await openCallInfo(b);
  await expect(b.getByTestId('call-emoji')).toContainText(emojiA!.trim()); // B sees A's pictures (and its own)
  await closeCallInfo(b);
  await remoteVideoArrives(a);
  await remoteVideoArrives(b);

  // Mute and camera off work without ending the call.
  await a.getByTestId('mute').click();
  await expect(a.getByTestId('mute')).toHaveAttribute('aria-label', 'Unmute');
  await a.getByTestId('camera').click();
  await expect(a.getByTestId('camera')).toHaveAttribute('aria-label', 'Turn camera on');

  // Hang up.
  await a.getByTestId('hang-up').click();
  await expect(a.getByTestId('call-status')).toHaveText('Call ended');
  await expect(b.getByTestId('call-status')).toHaveText('Call ended');
  const tracksLeft = await a.evaluate(() => (document.querySelector('[data-testid=remote-video]') as HTMLVideoElement | null)?.srcObject ?? null);
  expect(tracksLeft).toBeNull();

  // The call screen closes by itself (nothing to press) and the chat says how the call went.
  await expect(a.getByTestId('call-screen')).toHaveCount(0, { timeout: 10_000 });
  await expect(b.getByTestId('call-screen')).toHaveCount(0, { timeout: 10_000 });
  await expect(a.getByTestId('call-end-note').last()).toContainText(/Video call · \d+ min/);

  // Chat still works after the call.
  await a.getByTestId('message-input').fill('Still here');
  await a.getByTestId('send').click();
  await expect(b.getByTestId('msg-them').last()).toHaveText(/Still here/);

  // No network requests except the page itself (no outside code, fonts or trackers).
  const outside = requests.filter((u) => !/^(http:\/\/127\.0\.0\.1:4318\/(p2p\.html(\?.*)?|favicon\.ico)|ws:\/\/127\.0\.0\.1:9\/?)$/.test(u));
  expect(outside).toEqual([]);

  // The other side leaves: online -> offline · last seen HH:MM.
  await b.close();
  await expect(a.getByTestId('presence')).toHaveText(/^offline · last seen \d{1,2}:\d{2}/, { timeout: 20_000 });
  await openInfo(a);
  await expect(a.getByTestId('path-label')).toHaveText('Offline');
  await closeInfo(a);

  // Calling someone offline fails in plain words.
  await a.getByTestId('video-call').click();
  await expect(a.getByTestId('call-status')).toHaveText('Ravi is offline');
  // Back to the chat by itself, with the reason and "Call again".
  await expect(a.getByTestId('call-screen')).toHaveCount(0, { timeout: 10_000 });
  await expect(a.getByTestId('call-end-note').last()).toContainText('Video call · Ravi is offline');
  await expect(a.getByTestId('call-again').last()).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});

test('declined call', async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await connect(browser);
  await a.getByTestId('voice-call').click();
  await expect(b.getByTestId('call-status')).toHaveText('Voice call');
  await expect(a.getByTestId('call-status')).toHaveText('Ringing…');
  await b.getByTestId('decline').click();
  await expect(a.getByTestId('call-status')).toHaveText('Ravi declined');
  // Back to the chat by itself (no button to press), with the reason and "Call again".
  await expect(a.getByTestId('call-screen')).toHaveCount(0, { timeout: 10_000 });
  await expect(b.getByTestId('call-screen')).toHaveCount(0, { timeout: 10_000 });
  await expect(a.getByTestId('call-end-note').last()).toContainText('Voice call · Ravi declined');
  await expect(a.getByTestId('peer-name')).toHaveText('Ravi');
  // "Call again" from the chat rings again.
  await a.getByTestId('call-again').last().click();
  await expect(b.getByTestId('call-status')).toHaveText('Voice call', { timeout: 15_000 });
  await ctxA.close();
  await ctxB.close();
});

test('no answer (short ring time for the test)', async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await connect(browser, '?ring=3000');
  await recordCallStates(a);
  await a.getByTestId('video-call').click();
  await expect(b.getByTestId('call-status')).toHaveText('Video call');
  await expect(a.getByTestId('call-status')).toHaveText('Ravi didn’t answer', { timeout: 10_000 });
  expect(await callStates(a)).toEqual(['reaching', 'ringing', 'failed']);
  await expect(b.getByTestId('call-status')).toHaveText('Missed call from Asha');
  await ctxA.close();
  await ctxB.close();
});

const breakCamera = (p: Page) =>
  p.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('No camera', 'NotFoundError'));
  });

test("caller's camera or microphone can't open", async ({ browser }) => {
  const { ctxA, ctxB, a } = await connect(browser);
  await breakCamera(a);
  await a.getByTestId('video-call').click();
  await expect(a.getByTestId('call-status')).toHaveText("Your camera or microphone isn't available");
  // The reason stays readable in the chat; nothing blocks on an OK.
  await expect(a.getByTestId('call-screen')).toHaveCount(0, { timeout: 10_000 });
  await expect(a.getByTestId('call-end-note').last()).toContainText("Your camera or microphone isn't available");
  await ctxA.close();
  await ctxB.close();
});

test("callee's camera or microphone fails after Accept", async ({ browser }) => {
  const { ctxA, ctxB, a, b } = await connect(browser);
  await breakCamera(b);
  await a.getByTestId('video-call').click();
  await b.getByTestId('accept').click();
  await expect(a.getByTestId('call-status')).toHaveText("Ravi's camera or microphone isn't available");
  await expect(b.getByTestId('call-status')).toHaveText("Your camera or microphone isn't available");
  await ctxA.close();
  await ctxB.close();
});

test('restore from 24 words gives the same ID', async ({ browser }) => {
  const ctx1 = await browser.newContext();
  const p1 = await ctx1.newPage();
  await p1.goto(`/p2p.html?${NO_RELAY}`);
  const words = await newAccount(p1, '');
  await tab(p1, 'me');
  const id = await p1.getByTestId('my-id').textContent();
  const emoji = await p1.getByTestId('my-emoji').textContent();

  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto(`/p2p.html?${NO_RELAY}`);
  await p2.getByTestId('restore').click();
  await p2.getByTestId('restore-words').fill(words);
  await p2.getByTestId('restore-go').click();
  await tab(p2, 'me');
  await expect(p2.getByTestId('my-id')).toHaveText(id!);
  await expect(p2.getByTestId('my-emoji')).toHaveText(emoji!);
  await ctx1.close();
  await ctx2.close();
});
