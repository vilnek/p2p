import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { makeAccount, metric, showCard, tab } from './lab';

// TEST LAB · the Android app (debug APK) on the lab's own emulator ⇄ desktop Chrome, through the REAL
// public relays (the app's built-in list). Driven with adb + uiautomator (the app's WebView exposes
// its buttons and fields as accessibility nodes). Run: npm run lab:real -- real-android
// Needs: emulator LAB_ADB_SERIAL (default emulator-5590) booted with com.vilnek.p2p installed.
const SERIAL = process.env.LAB_ADB_SERIAL || 'emulator-5590';
const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const adb = (...a: string[]) => execFileSync(ADB, ['-s', SERIAL, ...a], { timeout: 120_000 }).toString();

interface Node {
  text: string;
  desc: string;
  cls: string;
  bounds?: string;
  x: number;
  y: number;
}
function dump(): Node[] {
  for (let i = 0; ; i++) {
    try {
      adb('shell', 'uiautomator', 'dump', '/sdcard/lab.xml');
      break;
    } catch (e) {
      if (i >= 3) throw e; // uiautomator busy: try again
      execFileSync('sleep', ['2']);
    }
  }
  const xml = adb('shell', 'cat', '/sdcard/lab.xml');
  const out: Node[] = [];
  const un = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const m of xml.matchAll(/<node [^>]*>/g)) {
    const n = m[0];
    const g = (k: string) => un(n.match(new RegExp(`${k}="([^"]*)"`))?.[1] ?? '');
    const b = g('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    out.push({ text: g('text'), desc: g('content-desc'), cls: g('class'), bounds: g('bounds'), x: (Number(b[1]) + Number(b[3])) / 2, y: (Number(b[2]) + Number(b[4])) / 2 });
  }
  return out;
}
const screenText = () => dump().map((n) => `${n.text} ${n.desc}`).join('\n');
async function waitFor(re: RegExp, ms = 60_000): Promise<Node> {
  const end = Date.now() + ms;
  let last: Node[] = [];
  while (Date.now() < end) {
    try {
      last = dump();
    } catch {
      /* uiautomator busy */
    }
    const all = last.filter((n) => re.test(n.text) || re.test(n.desc));
    // A round button and its caption can share a name: tap the button.
    const hit = all.find((n) => n.cls.endsWith('Button')) ?? all[0];
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Android: "${re}" not on screen. Seen: ${last.map((n) => n.text || n.desc).filter(Boolean).join(' | ').slice(0, 1500)}`);
}
async function tap(re: RegExp, ms?: number): Promise<void> {
  const n = await waitFor(re, ms);
  adb('shell', 'input', 'tap', String(Math.round(n.x)), String(Math.round(n.y)));
}
/** Taps the last text field on screen (the page's textareas have no label in the tree). */
async function tapField(ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const f = dump().filter((n) => n.cls.endsWith('EditText')).at(-1);
    if (f) return void adb('shell', 'input', 'tap', String(Math.round(f.x)), String(Math.round(f.y)));
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('Android: no text field on screen');
}
/** Types into the focused field (adb input text: spaces as %s, shell-special characters escaped). */
function type(text: string): void {
  // In pieces: one long `input text` can drop characters.
  for (let i = 0; i < text.length; i += 16) adb('shell', 'input', 'text', text.slice(i, i + 16).replace(/([\\'"`$&|;<>()#*?~])/g, '\\$1').replace(/ /g, '%s'));
}
/** The text now in the last text field. */
const fieldText = () => dump().filter((n) => n.cls.endsWith('EditText')).at(-1)?.text ?? '';
function shot(name: string): void {
  writeFileSync(`tests/lab/out/android-${name}.png`, execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p']));
}

test('Android app (emulator) ⇄ desktop Chrome over the real relays: account, one-scan, chat both ways, video call, screen share, file', async ({ browser }) => {
  test.setTimeout(30 * 60_000);
  const steps: Record<string, string> = {};
  // Fresh app.
  adb('shell', 'pm', 'clear', 'com.vilnek.p2p');
  adb('shell', 'pm', 'grant', 'com.vilnek.p2p', 'android.permission.CAMERA');
  adb('shell', 'pm', 'grant', 'com.vilnek.p2p', 'android.permission.RECORD_AUDIO');
  adb('shell', 'am', 'start', '-W', '-n', 'com.vilnek.p2p/.MainActivity');
  // 1 · account on the phone.
  // The first start after an install can land back on the home screen: start it again once.
  try {
    await waitFor(/^Make my account$/i, 40_000);
  } catch {
    adb('shell', 'am', 'start', '-W', '-n', 'com.vilnek.p2p/.MainActivity');
  }
  await tap(/^Make my account$/i, 120_000); // the device name is filled in ("Android phone")
  await tap(/written them down/i, 60_000); // the 24 words
  await waitFor(/^Chats$/);
  steps.account = 'ok';
  shot('1-account');

  // 2 · desktop Chrome, real relays (no ?relays=), shows its code; the phone pastes it.
  const ctx = await browser.newContext();
  const d: Page = await ctx.newPage();
  await d.goto('/p2p.html');
  await makeAccount(d, 'Lab Desk');
  const link = await showCard(d);
  const t0 = Date.now();
  await tap(/^Add$/);
  await tap(/^Paste a code or link$/i);
  // adb's `input text` sometimes drops a piece on a busy emulator: check, clear and type again.
  let typed = '';
  for (let attempt = 1; attempt <= 4 && typed !== link; attempt++) {
    await tapField();
    if (attempt > 1) {
      adb('shell', 'input', 'keycombination', '113', '29'); // Ctrl+A
      adb('shell', 'input', 'keyevent', '67'); // Delete
    }
    type(link);
    typed = fieldText();
    steps.typeAttempts = String(attempt);
  }
  expect(typed, 'the link typed into the phone is not the same as the one shown').toBe(link);
  await tap(/^Continue$/i);
  await expect(d.getByTestId('peer-name')).not.toHaveText('', { timeout: 90_000 });
  steps.desktopSees = (await d.getByTestId('peer-name').textContent()) ?? '';
  steps.oneScan = `ok in ${((Date.now() - t0) / 1000).toFixed(1)} s`;
  shot('2-connected');

  // 3 · chat both ways.
  await d.getByTestId('message-input').fill('Hello phone from the lab');
  await d.getByTestId('send').click();
  await waitFor(/Hello phone from the lab/, 30_000);
  await tapField();
  type('Hello desk from Android');
  await tap(/^Send$/);
  await expect(d.getByTestId('msg-them').last()).toContainText('Hello desk from Android', { timeout: 30_000 });
  steps.chat = 'ok both ways';

  // 4 · video call: desktop calls, the phone accepts.
  try {
    await d.getByTestId('video-call').click();
    shot('4-ringing');
    await waitFor(/^(Accept|Answer)$/, 45_000);
    // Tap every node named Answer (button first) until the ringing screen goes away.
    const cands = dump().filter((n) => /^(Accept|Answer)$/.test(n.text) || /^(Accept|Answer)$/.test(n.desc));
    steps.answerNodes = cands.map((n) => `${n.cls.split('.').pop()}${n.bounds}`).join(' ');
    for (const n of [...cands.filter((c) => c.cls.endsWith('Button')), ...cands.filter((c) => !c.cls.endsWith('Button'))]) {
      adb('shell', 'input', 'tap', String(Math.round(n.x)), String(Math.round(n.y)));
      await new Promise((r) => setTimeout(r, 4000));
      if (!dump().some((x) => /^(Accept|Answer)$/.test(x.text) || /^(Accept|Answer)$/.test(x.desc))) break;
    }
    steps.afterAnswer = screenText().replace(/\s+/g, ' ').slice(0, 400);
    await expect(d.getByTestId('call-status')).toHaveText(/^\d\d:\d\d$/, { timeout: 45_000 });
    await d.waitForTimeout(10_000);
    shot('4-call');
    steps.call = `ok, desktop timer ${await d.getByTestId('call-status').textContent()}`;
    // 4b · the phone shares its screen (Android asks first: the system's screen-capture dialog).
    try {
      await tap(/^Share screen$/, 20_000);
      await tap(/^(Start now|Start|Next|Share screen|Share entire screen|Entire screen)$/i, 30_000);
      const again = dump().find((n) => /^(Start now|Start|Share screen)$/i.test(n.text));
      if (again) adb('shell', 'input', 'tap', String(Math.round(again.x)), String(Math.round(again.y)));
      await waitFor(/You are sharing your screen|Stop sharing/, 30_000);
      // The desktop now gets a portrait picture (the phone's screen), not the camera.
      await expect
        .poll(() => d.evaluate(() => [...document.querySelectorAll('video')].some((v) => v.videoHeight > v.videoWidth * 1.4 && v.videoWidth > 0)), { timeout: 30_000 })
        .toBe(true);
      shot('4b-sharing');
      await tap(/^Stop sharing$/, 20_000);
      steps.screenShare = 'ok (portrait phone screen seen on desktop)';
    } catch (e) {
      steps.screenShare = `FAIL: ${(e as Error).message.split('\n')[0].slice(0, 300)}`;
      shot('4b-share-fail');
    }
    await d.getByTestId('hang-up').click();
  } catch (e) {
    const plain = (e as Error).message.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(Boolean).slice(0, 6).join(' / ');
    let phone = '';
    try {
      phone = screenText().replace(/\s+/g, ' ').slice(0, 500);
    } catch {}
    steps.call = `FAIL: ${plain.slice(0, 400)} · desktop call-status: ${await d.getByTestId('call-status').textContent({ timeout: 2000 }).catch(() => 'none')} · phone shows: ${phone}`;
    shot('4-call-fail');
  }

  // 5 · file: desktop sends 5 MB; the phone wrote first, so it comes in at once.
  try {
    await d.keyboard.press('Escape');
    const ok = d.getByTestId('call-screen').getByRole('button', { name: 'OK' });
    if (await ok.count()) await ok.click({ timeout: 5000 });
    await tab(d, 'chats');
    await d.getByTestId('contact').first().click({ timeout: 20_000 });
    await d.getByTestId('attach').click();
    const chooser = d.waitForEvent('filechooser');
    await d.getByTestId('pick-files').click();
    const buffer = Buffer.alloc(5 * 1024 * 1024, 7);
    await (await chooser).setFiles({ name: 'lab-5mb.bin', mimeType: 'application/octet-stream', buffer });
    await expect(d.getByTestId('file-me')).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
    await waitFor(/received, checked|lab-5mb\.bin/, 30_000);
    steps.file = 'ok (desktop: sent; phone shows it)';
  } catch (e) {
    steps.file = `FAIL: ${(e as Error).message.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0].slice(0, 300)}`;
    shot('5-file-fail');
  }
  shot('5-end');
  metric('android-emulator-real-relays', steps);
  await ctx.close();
  expect(Object.values(steps).filter((s) => s.startsWith('FAIL'))).toEqual([]);
});
