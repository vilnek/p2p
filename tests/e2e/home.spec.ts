import { expect, test, type Page } from '@playwright/test';
import { People, fragment, makeInvite } from './fixtures';
import { doneWords, makeAccount } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// The home page (design P3): the first screen for a visitor with no
// account. Existing flows stay: #c= links (join / "Connect?"), restore, Chats for an account holder.
// The video loads nothing from YouTube before Play. LOCAL mock relay only; YouTube is never reached
// (its player address is answered by a stub here).

let relay: MockRelay;
test.beforeAll(async () => (relay = await startMockRelay()));
test.afterAll(async () => relay.close());
let people: People;
test.beforeEach(({ browser }) => void (people = new People(browser, () => relay)));
test.afterEach(async () => people.close());

const EMBED = 'https://www.youtube-nocookie.com/embed/Sj6hNUUDaIQ?autoplay=1&rel=0';
const SOON = ['play', 'iphone', 'ipad', 'mac', 'windows'] as const;

async function noSideScroll(p: Page, where: string): Promise<void> {
  const r = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, bw: document.body.scrollWidth }));
  expect(Math.max(r.sw, r.bw), `horizontal scroll on ${where}`).toBeLessThanOrEqual(r.w);
}

test('a visitor with no account sees the home page: top bar, hero, create card, video, download, features, steps, footer', async () => {
  const p = await people.page(undefined, 'visitor');
  await p.goto(people.q());
  await expect(p.getByTestId('home')).toBeVisible();
  await expect(p.getByTestId('home-title')).toHaveText('Chat, call and sharestraight from you to them.');
  await expect(p.getByTestId('restore')).toHaveText('I have 24 words');
  await expect(p.getByTestId('home-open')).toHaveText('Open P2P Talk');
  await expect(p.getByTestId('home-create')).toHaveText('Create my account, free');
  await expect(p.getByTestId('home-watch')).toHaveText('▶ Watch the video');
  await expect(p.getByTestId('home-create-card')).toContainText('Create your account in 10 seconds');
  await expect(p.getByTestId('name')).toHaveAttribute('placeholder', 'Your name, e.g. Kavya Reddy');
  await expect(p.getByTestId('terms')).toContainText('By continuing you agree to the Terms and the Privacy policy. You’ll get 24 secret words to keep your account safe.');
  await expect(p.getByTestId('home-video-audio')).toHaveText('Audio: हिन्दी · English (switch in the player’s ⚙ settings)');
  await expect(p.getByTestId('home-features').locator('.hm-f')).toHaveCount(6);
  await expect(p.getByTestId('home-how').locator('.hm-step')).toHaveCount(3);
  await expect(p.getByTestId('home-footer').locator('.hm-fchip')).toHaveText(['Blog', 'Features', 'Terms', 'Privacy', 'Open source', 'About', 'Contact', 'YouTube']);
  await expect(p.getByTestId('home-footer')).toContainText('© 2026 Vilnek Private Limited · Made in India · info@vilnek.in');
  await expect(p.getByTestId('foot-terms')).toHaveAttribute('href', 'https://p2p.vilnek.in/terms/');
  await expect(p.getByTestId('foot-privacy')).toHaveAttribute('href', 'https://p2p.vilnek.in/privacy/');
  // Images have alt text (the logo is decoration next to the name: empty alt).
  for (const img of await p.locator('.home img').all()) expect(await img.getAttribute('alt')).not.toBeNull();
  // The old welcome card is gone; nothing went outside this machine.
  await expect(p.getByTestId('device-name')).toHaveCount(0);
  await expect(p.locator('iframe')).toHaveCount(0);
  people.onlyLocal();
});

test('"Coming soon" stickers are not links; the Web sticker opens this site; the Blog chip is not a link yet', async () => {
  const p = await people.page(undefined, 'visitor');
  await p.goto(people.q());
  await expect(p.getByTestId('home-download').locator('.hm-stk')).toHaveCount(6);
  for (const id of SOON) {
    for (const testid of [`store-${id}`, `store-mini-${id}`]) {
      const s = p.getByTestId(testid);
      await expect(s).toHaveAttribute('aria-disabled', 'true');
      expect(await s.evaluate((el) => el.tagName)).toBe('SPAN');
      expect(await s.getAttribute('href')).toBeNull();
      await expect(s).toHaveAttribute('aria-label', /coming soon/);
    }
    await expect(p.getByTestId(`store-${id}`)).toContainText('Coming soon');
  }
  const url = p.url();
  await p.getByTestId('store-play').click({ force: true }); // aria-disabled: Playwright would wait for it to be enabled
  expect(p.url()).toBe(url); // nothing happens
  const web = p.getByTestId('store-web');
  expect(await web.evaluate((el) => el.tagName)).toBe('A');
  await expect(web).toHaveAttribute('href', 'http://127.0.0.1:4318/');
  await expect(web).toContainText('Open on the');
  await expect(p.getByTestId('store-mini-web')).toHaveCount(0); // the top bar has no Web sticker
  const blog = p.getByTestId('foot-blog');
  expect(await blog.evaluate((el) => el.tagName)).toBe('SPAN');
  await expect(blog).toHaveAttribute('aria-disabled', 'true');
});

test('the video: only a picture until Play; then the privacy-enhanced player; Watch the video and the play sticker scroll to it', async () => {
  const p = await people.page(undefined, 'visitor');
  const youtube: string[] = [];
  await p.route(/youtube/, (r) => {
    youtube.push(r.request().url());
    return r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>player</title><p>player stub</p>' });
  });
  await p.goto(people.q());
  await expect(p.getByTestId('home-video-play')).toBeVisible();
  // Scroll the whole page: still nothing from YouTube.
  await p.mouse.wheel(0, 4000);
  await p.waitForTimeout(500);
  expect(youtube).toEqual([]);
  await expect(p.locator('iframe')).toHaveCount(0);
  await p.evaluate(() => window.scrollTo(0, 0));
  // "Watch the video" scrolls to it and puts the keyboard on Play (it does not start it).
  await p.getByTestId('home-watch').click();
  await expect(p.getByTestId('home-video-play')).toBeFocused();
  await expect(p.getByTestId('home-video-play')).toBeInViewport();
  expect(youtube).toEqual([]);
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.getByTestId('home-top-video').click();
  await expect(p.getByTestId('home-video-play')).toBeFocused();
  expect(youtube).toEqual([]);
  // Play, from the keyboard.
  await p.keyboard.press('Enter');
  const frame = p.getByTestId('home-video-iframe');
  await expect(frame).toHaveAttribute('src', EMBED);
  await expect(frame).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  await expect(frame).toHaveAttribute('allow', /autoplay/);
  await expect.poll(() => youtube).toEqual([EMBED]);
  await expect(p.getByTestId('home-video-play')).toHaveCount(0);
});

test('Make my account from the home card: the covered words, the 3-word check, then Chats', async () => {
  const p = await people.page(undefined, 'visitor');
  await p.goto(people.q());
  // "Open P2P Talk" and "Create my account, free" put the keyboard on the name.
  await p.getByTestId('home-open').click();
  await expect(p.getByTestId('name')).toBeFocused();
  await p.evaluate(() => (document.activeElement as HTMLElement).blur());
  await p.getByTestId('home-create').click();
  await expect(p.getByTestId('name')).toBeFocused();
  await p.keyboard.type('Kavya Reddy');
  await p.getByTestId('make-account').click();
  await expect(p.getByTestId('words-cover')).toBeVisible();
  await expect(p.getByTestId('home')).toHaveCount(0);
  await doneWords(p);
  await expect(p.getByTestId('tab-chats')).toBeVisible();
  await p.getByTestId('tab-me').click();
  await expect(p.getByTestId('my-name')).toHaveText('Kavya Reddy');
  // With an account: straight to Chats, never the home page.
  await p.reload();
  await expect(p.getByTestId('tab-chats')).toBeVisible();
  await expect(p.getByTestId('home')).toHaveCount(0);
});

test('I have 24 words: the restore screen (with this device’s name); Back returns to the home page', async () => {
  const p = await people.page(undefined, 'visitor');
  await p.goto(people.q());
  await p.getByTestId('restore').click();
  await expect(p.getByTestId('restore-words')).toBeVisible();
  await expect(p.getByTestId('device-name')).not.toHaveValue('');
  await p.getByTestId('restore-back').click();
  await expect(p.getByTestId('home')).toBeVisible();
});

test('#c= links still work: a visitor gets the join screen, an account holder gets "Connect?"', async () => {
  const A = await people.person('Asha');
  const link = await makeInvite(A.page);
  // Visitor: the join screen, no home page.
  const v = await people.page(undefined, 'visitor');
  await v.goto(`${people.q()}${fragment(link)}`);
  await expect(v.getByTestId('join-screen')).toBeVisible();
  await expect(v.getByTestId('home')).toHaveCount(0);
  // Account holder: asked first.
  const B = await people.page(undefined, 'Ben');
  await B.goto(people.q());
  await makeAccount(B, 'Ben');
  await B.goto(`${people.q()}${fragment(await makeInvite(A.page))}`);
  await expect(B.getByTestId('link-confirm')).toBeVisible({ timeout: 15_000 });
  await expect(B.getByTestId('link-name')).toHaveText('Asha invited you');
  await expect(B.getByTestId('home')).toHaveCount(0);
});

test('inside the installed apps: no download stickers and no video; in the installed web app: no Web sticker', async () => {
  const ctx = await people.context();
  await ctx.addInitScript(() => ((window as unknown as { Capacitor: object }).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' }));
  const p = await people.page(ctx, 'app');
  await p.goto(people.q());
  await expect(p.getByTestId('home')).toBeVisible();
  await expect(p.getByTestId('make-account')).toBeVisible();
  await expect(p.getByTestId('restore')).toBeVisible();
  for (const t of ['home-download', 'home-video', 'home-top-stickers', 'home-watch']) await expect(p.getByTestId(t)).toHaveCount(0);
  await expect(p.getByTestId('home-features')).toBeVisible();

  const ctx2 = await people.context();
  await ctx2.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { configurable: true, get: () => true }));
  const w = await people.page(ctx2, 'pwa');
  await w.goto(people.q());
  await expect(w.getByTestId('home-download').locator('.hm-stk')).toHaveCount(5);
  await expect(w.getByTestId('store-web')).toHaveCount(0);
  await expect(w.getByTestId('home-video')).toBeVisible();
});

for (const [width, height] of [[360, 740], [390, 844], [1280, 800]] as const) {
  test(`home page layout at ${width} px: no side scroll, top bar fits, stickers wrap; screenshot`, async () => {
    const phone = width < 600;
    const ctx = await people.context({ viewport: { width, height }, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
    const p = await people.page(ctx, `w${width}`);
    await p.goto(people.q());
    await expect(p.getByTestId('home')).toBeVisible();
    await noSideScroll(p, `home ${width}`);
    // Top bar: logo, name and both buttons inside the bar, not overlapping.
    const bar = (await p.getByTestId('home-top').boundingBox())!;
    const boxes = [];
    for (const sel of ['.hm-logo', '.hm-brand', '[data-testid=restore]', '[data-testid=home-open]']) {
      const b = (await p.locator(sel).boundingBox())!;
      expect(b.x, `${sel} inside the bar`).toBeGreaterThanOrEqual(bar.x);
      expect(b.x + b.width, `${sel} inside the bar`).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
      boxes.push({ sel, ...b });
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        expect(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1, `${a.sel} overlaps ${b.sel}`).toBe(true);
      }
    // Top bar stickers only on wide screens; on phones the big stickers wrap inside the page.
    await expect(p.getByTestId('home-top-stickers')).toBeVisible({ visible: !phone });
    for (const s of await p.getByTestId('home-download').locator('.hm-stk').all()) {
      const b = (await s.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(width);
    }
    // Buttons are at least 40 px tall (touch).
    for (const t of ['restore', 'home-open', 'home-create', 'make-account']) expect((await p.getByTestId(t).boundingBox())!.height).toBeGreaterThanOrEqual(40);
    // The bundled pictures (logo, phone, video picture) are decoded and shown.
    await p.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
    await p.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await p.locator('.home img').count()).toBe(3);
    await p.screenshot({ path: `docs/screens/home-${width}.png`, fullPage: true });
  });
}
