import { expect, test, type Page } from '@playwright/test';
import { People, fragment } from './fixtures';
import { CONNECTED, join } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// Embedded mode (?embed=1) for the Vilnek OS Mac app: no screens; everything through window.P2PTalk.
// LOCAL mock relay only.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

type Ev = { e: string; d: Record<string, unknown> };
declare global {
  interface Window {
    P2PTalk: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    __ev: Ev[];
  }
}

/** Load the embedded page and record every event (MediaStreams replaced by their track kinds). */
async function embedded(page: Page): Promise<void> {
  await page.goto(people.q('&embed=1'));
  await page.waitForFunction(() => !!window.P2PTalk);
  await page.evaluate(() => {
    window.__ev = [];
    for (const e of ['ready', 'contact', 'request', 'message', 'call', 'stream', 'recording', 'screen', 'invite', 'devices', 'file'])
      window.P2PTalk.on(e, (d: Record<string, unknown>) => {
        const copy: Record<string, unknown> = { ...d };
        if (d && d.stream instanceof MediaStream) copy.stream = d.stream.getTracks().map((t) => t.kind);
        if (d && d.blob instanceof Blob) copy.blob = d.blob.size;
        window.__ev.push({ e, d: copy });
      });
  });
}

const events = (page: Page, e: string) => page.evaluate((name) => window.__ev.filter((x) => x.e === name).map((x) => x.d), e);
async function waitEvent(page: Page, e: string, match: Record<string, unknown> = {}, timeout = 30_000): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined;
  await expect
    .poll(async () => {
      found = (await events(page, e)).find((d) => Object.entries(match).every(([k, v]) => d?.[k] === v));
      return !!found;
    }, { timeout })
    .toBe(true);
  return found!;
}

test('two embedded pages: invite, request, accept, message, call states, stream, recording', async () => {
  const ctxA = await people.context();
  const ctxB = await people.context();
  let a = await people.page(ctxA, 'A');
  let b = await people.page(ctxB, 'B');
  await embedded(a);
  await embedded(b);

  // The page tells the host what it speaks.
  const v = await a.evaluate(() => window.P2PTalk.version());
  expect(v.protocol).toBe(1);
  expect(v.features).toEqual(expect.arrayContaining(['chat', 'call', 'rec', 'device', 'screen']));
  expect(v.build).toMatch(/^\d+\.\d+\.\d+\+\d{4}-\d\d-\d\d$/);
  // No screens at all.
  await expect(a.locator('#app')).toBeEmpty();

  const wordsA = await a.evaluate(() => window.P2PTalk.newWords());
  const wordsB = await b.evaluate(() => window.P2PTalk.newWords());
  const meA = await a.evaluate((w) => window.P2PTalk.start({ words: w, name: 'Dr Vijay', deviceName: 'Mac', keep: true }), wordsA);
  const meB = await b.evaluate((w) => window.P2PTalk.start({ words: w, name: 'Ravi', deviceName: 'iPhone' }), wordsB);
  expect(meA.id).toMatch(/^\d{24}$/);
  expect(meA.deviceName).toBe('Mac');
  // In memory only: the page stored no identity for B.
  expect(meB.kept).toBe(false);

  // A makes an invite, then goes away.
  const inv = await a.evaluate(() => window.P2PTalk.makeInvite({ ttl: '1h', name: 'Dr Vijay' }));
  expect(inv.link).toMatch(/^https:\/\/p2p\.vilnek\.in\/#c=/);
  await a.close();

  // B opens it: the request waits on the relay. B goes away too.
  const opened = await b.evaluate((l) => window.P2PTalk.openLink(l), inv.link);
  expect(opened).toEqual({ state: 'request-sent', contactId: meA.id });
  await b.close();

  // A comes back (identity kept by request): the "request" event, then accept(requestId).
  a = await people.page(ctxA, 'A');
  await embedded(a);
  await a.evaluate(() => window.P2PTalk.start({ resume: true }));
  const req = await waitEvent(a, 'request');
  expect(req.name).toBe('Ravi');
  expect(req.id).toBe(meB.id);
  const c = await a.evaluate((id) => window.P2PTalk.accept(id), req.requestId as string);
  expect(c.name).toBe('Ravi');

  // B comes back (same words): the acceptance waits for it; they connect.
  b = await people.page(ctxB, 'B');
  await embedded(b);
  await b.evaluate((w) => window.P2PTalk.start({ words: w, name: 'Ravi', deviceName: 'iPhone' }), wordsB);
  const online = await waitEvent(b, 'contact', { id: meA.id, online: true });
  expect(online.device).toBe('Mac');
  // The path follows as soon as it is known (a later "contact" event).
  await expect.poll(async () => (await events(b, 'contact')).some((d) => (d.path as { kind: string }).kind === 'local'), { timeout: 15_000 }).toBe(true);
  await waitEvent(a, 'contact', { id: meB.id, online: true });

  // Messages both ways.
  await a.evaluate((id) => window.P2PTalk.send(id, 'Namaste from Vilnek OS'), meB.id);
  expect((await waitEvent(b, 'message', { from: 'them' })).text).toBe('Namaste from Vilnek OS');
  await b.evaluate((id) => window.P2PTalk.send(id, 'Hello'), meA.id);
  expect((await waitEvent(a, 'message', { from: 'them' })).text).toBe('Hello');
  expect(await a.evaluate((id) => window.P2PTalk.history(id), meB.id)).toEqual([
    expect.objectContaining({ from: 'me', text: 'Namaste from Vilnek OS' }),
    expect.objectContaining({ from: 'them', text: 'Hello' }),
  ]);

  // A video call: reaching → ringing / incoming → connecting → connected; the remote stream.
  await a.evaluate((id) => window.P2PTalk.call(id, { video: true }), meB.id);
  await waitEvent(b, 'call', { state: 'incoming', video: true });
  await waitEvent(a, 'call', { state: 'ringing' });
  await b.evaluate(() => window.P2PTalk.acceptCall());
  await waitEvent(a, 'call', { state: 'connected' });
  await waitEvent(b, 'call', { state: 'connected' });
  expect((await events(a, 'call')).map((x) => x.state)).toEqual(['reaching', 'ringing', 'connecting', 'connected']);
  // "stream" fires as tracks arrive (sound first, then video).
  await expect.poll(async () => (await events(b, 'stream')).some((d) => d.kind === 'remote' && (d.stream as string[]).includes('video')), { timeout: 15_000 }).toBe(true);
  expect(await a.evaluate(() => window.P2PTalk.getRemoteStream()?.getVideoTracks().length)).toBe(1);
  expect(await a.evaluate(() => window.P2PTalk.getLocalStream()?.getTracks().length)).toBe(2);

  // Recording indicator and a replaced video track (screen share from the host).
  await a.evaluate(() => window.P2PTalk.setRecording(true));
  await waitEvent(b, 'recording', { on: true });
  await a.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 180 });
    const g = canvas.getContext('2d')!;
    setInterval(() => g.fillRect(Math.random() * 300, 0, 20, 20), 50);
    await window.P2PTalk.replaceVideoTrack(canvas.captureStream(10).getVideoTracks()[0]);
  });
  await a.evaluate(() => window.P2PTalk.hangUp());
  await waitEvent(b, 'call', { state: 'ended' });
  await waitEvent(b, 'recording', { on: false });

  // Connection details for support.
  expect(await a.evaluate(() => window.P2PTalk.connectionDetails())).toContain('Attempt:');
  people.onlyLocal();
});

test('recording indicator: an embedded caller records, the other page shows "● Dr Vijay is recording"', async () => {
  const a = await people.page(undefined, 'A');
  await embedded(a);
  await a.evaluate(async () => window.P2PTalk.start({ words: window.P2PTalk.newWords(), name: 'Dr Vijay', deviceName: 'Mac' }));
  const inv = await a.evaluate(() => window.P2PTalk.makeInvite({ ttl: '1h' }));
  const b = await people.page(undefined, 'B');
  await b.goto(`${people.q()}${fragment(inv.link)}`);
  await join(b, 'Ravi');
  const contact = await waitEvent(a, 'contact', { online: true });
  await expect(b.getByTestId('peer-name')).toHaveText('Dr Vijay', { timeout: 20_000 });

  await a.evaluate((id) => window.P2PTalk.call(id, { video: true }), contact.id as string);
  await b.getByTestId('accept').click();
  await expect(b.getByTestId('call-status')).toHaveText(CONNECTED, { timeout: 25_000 });
  await expect(b.getByTestId('call-rec')).toBeHidden();
  await a.evaluate(() => window.P2PTalk.setRecording(true));
  await expect(b.getByTestId('call-rec')).toBeVisible();
  await expect(b.getByTestId('call-rec')).toHaveText('Dr Vijay is recording');
  await a.evaluate(() => window.P2PTalk.setRecording(false));
  await expect(b.getByTestId('call-rec')).toBeHidden();
  people.onlyLocal();
});
