import { expect, test } from '@playwright/test';
import { People, fragment, makeInvite } from './fixtures';
import { CONNECTED, join } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// Screen sharing in a call: my screen replaces my camera on the same video sender (no
// renegotiation), "You are sharing your screen", the other side shows it whole; stopping (from the
// app or the browser's own bar) goes back to the camera. LOCAL mock relay only.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

test('share my screen in a video call, then stop (button and browser bar)', async () => {
  const A = await people.person('Dr Vijay');
  const link = await makeInvite(A.page);
  const b = await people.page(undefined, 'Ravi');
  await b.goto(`${people.q()}${fragment(link)}`);
  await join(b, 'Ravi');
  await expect(A.page.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 20_000 });
  const a = A.page;

  await a.getByTestId('video-call').click();
  await b.getByTestId('accept').click();
  await expect(a.getByTestId('call-status')).toHaveText(CONNECTED, { timeout: 25_000 });
  const sender = () =>
    a.evaluate(() => {
      const v = document.querySelector('[data-testid=local-video]') as HTMLVideoElement;
      return (v.srcObject as MediaStream | null)?.getVideoTracks()[0]?.label ?? '';
    });
  const cameraLabel = await sender();

  await a.getByTestId('screen-share').click();
  await expect(a.getByTestId('sharing-pill')).toBeVisible();
  await expect(a.getByTestId('screen-share')).toHaveAttribute('aria-label', 'Stop sharing');
  await expect(b.getByTestId('call-screen')).toHaveClass(/their-screen/);
  // The call stayed connected (same sender, no new negotiation needed).
  await expect(a.getByTestId('call-status')).toHaveText(CONNECTED);

  await a.getByTestId('screen-share').click();
  await expect(a.getByTestId('sharing-pill')).toBeHidden();
  await expect(b.getByTestId('call-screen')).not.toHaveClass(/their-screen/);
  expect(await sender()).toBe(cameraLabel);

  // Stopped from the browser's own bar: the track ends, and the app goes back to the camera.
  await a.evaluate(() => {
    const md = navigator.mediaDevices;
    const orig = md.getDisplayMedia.bind(md);
    md.getDisplayMedia = async (c) => {
      const s = await orig(c);
      (window as unknown as { __share: MediaStreamTrack }).__share = s.getVideoTracks()[0];
      return s;
    };
  });
  await a.getByTestId('screen-share').click();
  await expect(b.getByTestId('call-screen')).toHaveClass(/their-screen/);
  await a.evaluate(() => {
    const t = (window as unknown as { __share: MediaStreamTrack }).__share;
    t.stop();
    t.dispatchEvent(new Event('ended')); // what the browser's "Stop sharing" bar does
  });
  await expect(a.getByTestId('sharing-pill')).toBeHidden();
  await expect(b.getByTestId('call-screen')).not.toHaveClass(/their-screen/);
  await expect(a.getByTestId('call-status')).toHaveText(CONNECTED);
  // The computer refuses (macOS: the browser has no screen-recording permission): one clear sentence
  // with the setting to change, never nothing at all. Closing the picker says nothing.
  await a.evaluate(() => {
    const md = navigator.mediaDevices;
    (window as unknown as { __gdm: unknown }).__gdm = md.getDisplayMedia;
    md.getDisplayMedia = async () => {
      throw new DOMException('Permission denied by system', 'NotAllowedError');
    };
  });
  await a.getByTestId('screen-share').click();
  await expect(a.getByTestId('share-error')).toBeVisible();
  await expect(a.getByTestId('share-error')).toContainText('allowed');
  await expect(a.getByTestId('sharing-pill')).toBeHidden();
  await expect(a.getByTestId('call-status')).toHaveText(CONNECTED);
  await a.evaluate(() => {
    document.querySelector('[data-testid=share-error]')?.remove();
    navigator.mediaDevices.getDisplayMedia = async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    };
  });
  await a.getByTestId('screen-share').click();
  await a.waitForTimeout(500);
  await expect(a.getByTestId('share-error')).toHaveCount(0);

  await a.getByTestId('hang-up').click();
  await expect(b.getByTestId('call-status')).toHaveText('Call ended');
  people.onlyLocal();
});

test('device sound goes with the screen: it keeps flowing while my mic is off; the pill can turn it off', async () => {
  const A = await people.person('Dr Vijay', '&testHooks=1');
  const link = await makeInvite(A.page);
  const b = await people.page(undefined, 'Ravi');
  await b.goto(`${people.q('&testHooks=1')}${fragment(link)}`);
  await join(b, 'Ravi');
  const a = A.page;
  await expect(a.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 20_000 });
  // Chrome's fake screen has no sound: add a test tone as the "device sound" (what system audio gives).
  await a.evaluate(() => {
    const md = navigator.mediaDevices;
    const orig = md.getDisplayMedia.bind(md);
    md.getDisplayMedia = async (c) => {
      const s = await orig({ video: true });
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      osc.frequency.value = 440;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      s.addTrack(dest.stream.getAudioTracks()[0]);
      (window as unknown as { __askedSound: unknown }).__askedSound = (c as { audio?: unknown })?.audio;
      return s;
    };
  });
  await a.getByTestId('video-call').click();
  await b.getByTestId('accept').click();
  await expect(a.getByTestId('call-status')).toHaveText(CONNECTED, { timeout: 25_000 });
  const energy = () => b.evaluate(() => (window as unknown as { __p2pTest: { audioEnergy(): Promise<number> } }).__p2pTest.audioEnergy());
  const gained = async (ms = 1500) => {
    const e0 = await energy();
    await b.waitForTimeout(ms);
    return (await energy()) - e0;
  };

  await a.getByTestId('mute').click(); // my mic off
  await b.waitForTimeout(700);
  const silent = await gained();
  await a.getByTestId('screen-share').click();
  await expect(a.getByTestId('screen-sound')).toHaveText('Device sound on');
  expect(await a.evaluate(() => (window as unknown as { __askedSound: unknown }).__askedSound)).toBe(true);
  await b.waitForTimeout(700);
  const withSound = await gained();
  expect(withSound).toBeGreaterThan(Math.max(silent * 5, 1e-4)); // device sound flows, mic still off

  await a.getByTestId('screen-sound').click(); // device sound off
  await expect(a.getByTestId('screen-sound')).toHaveText('Device sound off');
  await b.waitForTimeout(700);
  expect(await gained()).toBeLessThan(withSound / 5);

  // Stop sharing: the plain microphone again (still muted), the call goes on.
  await a.getByTestId('screen-share').click();
  await expect(a.getByTestId('sharing-pill')).toBeHidden();
  await expect(a.getByTestId('call-status')).toHaveText(CONNECTED);
  people.onlyLocal();
});
