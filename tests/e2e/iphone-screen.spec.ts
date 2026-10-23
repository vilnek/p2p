import { expect, test, type BrowserContext } from '@playwright/test';
import { People, fragment, makeInvite } from './fixtures';
import { CONNECTED, join, makeAccount } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// Screen sharing from the iPhone app (native/androidScreen.ts with the iPhone "ScreenCapture" plugin).
// The plugin is faked in the page: it sends base64 JPEG pictures (640x360) and 40 ms of 48 kHz stereo
// PCM, like ScreenCapturePlugin.swift does with what the ScreenShare extension captures. The other side
// must see the phone's screen and hear its sound; stopping from iOS's red status pill, from the app, or
// by hanging up must end it on both sides. LOCAL mock relay only.

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

interface FakeLog {
  starts: { fps: number; maxWidth: number; maxHeight: number; audio: boolean; binary: boolean }[];
  stops: number;
  frames: number;
}

/** The iPhone app's Capacitor bridge, with a fake ScreenCapture plugin. */
async function iphoneApp(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    type Fn = (e: Record<string, unknown>) => void;
    const on: Record<string, Fn[]> = { frame: [], audio: [], stopped: [] };
    const log = { starts: [] as unknown[], stops: 0, frames: 0 };
    let timer: ReturnType<typeof setInterval> | null = null;
    let phase = 0;
    const w = window as unknown as Record<string, unknown>;
    w.__iosLog = log;
    const emit = (ev: string, data: Record<string, unknown>) => on[ev].slice().forEach((f) => f(data));
    const b64 = (bytes: Uint8Array) => {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return btoa(s);
    };
    const tick = (canvas: HTMLCanvasElement, sound: boolean) => {
      const g = canvas.getContext('2d') as CanvasRenderingContext2D;
      g.fillStyle = `hsl(${(log.frames * 25) % 360}, 80%, 50%)`;
      g.fillRect(0, 0, 640, 360);
      log.frames++;
      emit('frame', { data: canvas.toDataURL('image/jpeg', 0.7).split(',')[1] });
      if (!sound) return;
      const n = 1920; // 40 ms at 48 kHz
      const pcm = new Int16Array(n * 2);
      for (let i = 0; i < n; i++) {
        const v = Math.round(Math.sin(phase) * 12000);
        phase += (2 * Math.PI * 440) / 48000;
        pcm[2 * i] = v;
        pcm[2 * i + 1] = v;
      }
      emit('audio', { data: b64(new Uint8Array(pcm.buffer)), channels: 2 });
    };
    const plugin = {
      async start(o: { audio: boolean }) {
        log.starts.push(o);
        await new Promise((ok) => setTimeout(ok, 150)); // the Start Broadcast sheet
        if (w.__iosCancel) throw Object.assign(new Error('Screen sharing was cancelled.'), { code: 'cancelled' });
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        timer = setInterval(() => tick(canvas, !!o.audio), 40);
        return { width: 640, height: 360, channels: o.audio ? 2 : 0 };
      },
      async stop() {
        log.stops++;
        if (timer) clearInterval(timer);
        timer = null;
      },
      addListener(ev: string, fn: Fn) {
        on[ev].push(fn);
        return { remove: async () => void (on[ev] = on[ev].filter((f) => f !== fn)) };
      },
    };
    // Stop in iOS's red status pill / Control Center: the extension ends, the plugin says "stopped".
    w.__iosStatusPillStop = () => {
      if (timer) clearInterval(timer);
      timer = null;
      emit('stopped', { reason: 'stopped' });
    };
    w.Capacitor = { getPlatform: () => 'ios', isPluginAvailable: (n: string) => n === 'ScreenCapture', Plugins: { ScreenCapture: plugin } };
  });
}

test('iPhone app: share the phone screen and its sound in a video call; stop from the status pill, the app, and by hanging up', async () => {
  const ctx = await people.context();
  await iphoneApp(ctx);
  const a = await people.page(ctx, 'Dr Vijay (iPhone)');
  await a.goto(people.q('&testHooks=1'));
  await makeAccount(a, 'Dr Vijay');
  const link = await makeInvite(a);
  const b = await people.page(undefined, 'Ravi');
  await b.goto(`${people.q('&testHooks=1')}${fragment(link)}`);
  await join(b, 'Ravi');
  await expect(a.getByTestId('peer-name')).toHaveText('Ravi', { timeout: 20_000 });
  const fake = () => a.evaluate(() => (window as unknown as { __iosLog: FakeLog }).__iosLog);

  await a.getByTestId('video-call').click();
  await b.getByTestId('accept').click();
  await expect(a.getByTestId('call-status')).toHaveText(CONNECTED, { timeout: 25_000 });
  const energy = () => b.evaluate(() => (window as unknown as { __p2pTest: { audioEnergy(): Promise<number> } }).__p2pTest.audioEnergy());
  const gained = async (ms = 1500) => {
    const e0 = await energy();
    await b.waitForTimeout(ms);
    return (await energy()) - e0;
  };
  const theirPicture = () => b.evaluate(() => {
    const v = document.querySelector('[data-testid=remote-video]') as HTMLVideoElement;
    return { w: v.videoWidth, h: v.videoHeight };
  });

  await a.getByTestId('mute').click(); // my mic off: what B hears now is the phone's sound
  await b.waitForTimeout(700);
  const silent = await gained();

  // Share screen: the plugin is asked for the screen with sound, base64 pictures (no binary port on iPhone).
  await a.getByTestId('screen-share').click();
  await expect(a.getByTestId('sharing-pill')).toBeVisible();
  await expect(a.getByTestId('screen-sound')).toHaveText('Device sound on');
  expect((await fake()).starts[0]).toMatchObject({ audio: true, binary: false, fps: 10, maxWidth: 1280, maxHeight: 1280 });
  await expect(b.getByTestId('call-screen')).toHaveClass(/their-screen/);
  await expect.poll(theirPicture, { timeout: 15_000 }).toEqual({ w: 640, h: 360 }); // the phone's pictures arrive
  await b.waitForTimeout(700);
  expect(await gained()).toBeGreaterThan(Math.max(silent * 5, 1e-4)); // and its sound

  // Stop from iOS's red status pill: back to the camera on both sides, the call goes on.
  await a.evaluate(() => (window as unknown as { __iosStatusPillStop(): void }).__iosStatusPillStop());
  await expect(a.getByTestId('sharing-pill')).toBeHidden();
  await expect(b.getByTestId('call-screen')).not.toHaveClass(/their-screen/);
  await expect(a.getByTestId('call-status')).toHaveText(CONNECTED);

  // Closing the Start Broadcast sheet without starting: nothing changes, and nothing is stopped on the
  // phone (a start that failed must never cancel another one still starting).
  const stopsBeforeCancel = (await fake()).stops;
  await a.evaluate(() => void ((window as unknown as { __iosCancel: boolean }).__iosCancel = true));
  await a.getByTestId('screen-share').click();
  await expect.poll(async () => (await fake()).starts.length).toBe(2);
  await a.waitForTimeout(500);
  await expect(a.getByTestId('sharing-pill')).toBeHidden();
  await expect(a.getByTestId('call-status')).toHaveText(CONNECTED);
  expect((await fake()).stops).toBe(stopsBeforeCancel);
  await a.evaluate(() => void ((window as unknown as { __iosCancel: boolean }).__iosCancel = false));

  // Stop from the app's own button: the phone's broadcast is stopped once.
  const stops0 = (await fake()).stops;
  await a.getByTestId('screen-share').click();
  await expect(b.getByTestId('call-screen')).toHaveClass(/their-screen/);
  await a.getByTestId('screen-share').click();
  await expect(a.getByTestId('sharing-pill')).toBeHidden();
  await expect(b.getByTestId('call-screen')).not.toHaveClass(/their-screen/);
  await expect.poll(async () => (await fake()).stops).toBe(stops0 + 1);

  // Hanging up while sharing stops the broadcast too.
  await a.getByTestId('screen-share').click();
  await expect(b.getByTestId('call-screen')).toHaveClass(/their-screen/);
  await a.getByTestId('hang-up').click();
  await expect(b.getByTestId('call-status')).toHaveText('Call ended');
  await expect.poll(async () => (await fake()).stops).toBe(stops0 + 2);
  people.onlyLocal();
});
