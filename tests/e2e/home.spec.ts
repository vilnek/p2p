import { expect, test, type Page } from '@playwright/test';
import { People, fragment, makeInvite } from './fixtures';
import { doneWords, makeAccount } from './helpers';
import { startMockRelay, type MockRelay } from './mock-relay';

// The home page (design P3; header and footer P4, 24 Oct 2026):
// the first screen for a visitor with no account. Existing flows stay: #c= links (join / "Connect?"), restore, Chats for an account holder.
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
const SOCIAL: [string, string][] = [
  ['facebook', 'https://facebook.com/vilnek'],
  ['x', 'https://x.com/Vilnek'],
  ['instagram', 'https://www.instagram.com/vilnek'],
  ['youtube', 'https://www.youtube.com/@vilneks'],
  ['linkedin', 'https://www.linkedin.com/company/vilnek'],
  ['telegram', 'https://t.me/vilnek'],
  ['whatsapp', 'https://wa.me/message/EZMPWIIQMIARE1'],
];

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
  // Top bar: a short menu, no store stickers.
  await expect(p.getByTestId('home-nav').locator('.hm-nav-i')).toHaveText(['Features', 'How it works', 'Download', 'Open source']);
  await expect(p.getByTestId('home-nav-source')).toHaveAttribute('href', 'https://github.com/vilnek/p2p');
  await expect(p.getByTestId('home-nav-source')).toHaveAttribute('target', '_blank');
  await expect(p.getByTestId('home-top').locator('.hm-stk')).toHaveCount(0);
  await expect(p.getByTestId('home-menu')).toBeHidden(); // ☰ only on narrow screens
  // Footer (iDentist.Live style): link columns, store buttons, Follow Vilnek, GitHub, Made in India.
  const foot = p.getByTestId('home-footer');
  await expect(foot.locator('.hm-fcol h4')).toHaveText(['P2P Talk', 'Vilnek', 'Legal']);
  await expect(foot.locator('.hm-flink')).toHaveText(['Features', 'How it works', 'Watch the video', 'BlogComing soon', 'About Vilnek', 'Contact us', 'vilnek.in', 'Privacy policy', 'Terms of use']);
  await expect(p.getByTestId('foot-terms')).toHaveAttribute('href', 'https://p2p.vilnek.in/terms/');
  await expect(p.getByTestId('foot-privacy')).toHaveAttribute('href', 'https://p2p.vilnek.in/privacy/');
  await expect(p.getByTestId('foot-about')).toHaveAttribute('href', 'https://vilnek.in/about');
  await expect(p.getByTestId('foot-contact')).toHaveAttribute('href', 'https://vilnek.in/contact');
  await expect(p.getByTestId('foot-site')).toHaveAttribute('href', 'https://vilnek.in/');
  await expect(p.getByTestId('foot-mail')).toHaveAttribute('href', 'mailto:info@vilnek.in');
  await expect(p.getByTestId('foot-github')).toHaveAttribute('href', 'https://github.com/vilnek/p2p');
  await expect(p.getByTestId('foot-github')).toContainText('GitHub');
  await expect(p.getByTestId('foot-follow')).toContainText('Follow Vilnek');
  await expect(p.getByTestId('foot-follow').locator('a.hm-soc')).toHaveCount(SOCIAL.length);
  for (const [id, url] of SOCIAL) {
    const a = p.getByTestId(`foot-social-${id}`);
    await expect(a).toHaveAttribute('href', url);
    await expect(a).toHaveAttribute('target', '_blank');
    await expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(a).toHaveAttribute('aria-label', /^Vilnek on /);
    await expect(a.locator('svg path')).toHaveCount(1); // the logo is drawn inline, nothing fetched
  }
  await expect(p.getByTestId('foot-made-in')).toHaveText('Made in Indiafor the world');
  await expect(p.getByTestId('foot-made-in').getByTestId('india-flag')).toBeVisible(); // drawn flag, not an emoji
  await expect(p.getByTestId('foot-copy')).toHaveText('© 2026 VILNEK PRIVATE LIMITED');
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
    for (const testid of [`store-${id}`]) {
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
  // The footer's store buttons: Google Play, App Store (iPhone, iPad, Mac), Microsoft Store: "Coming soon", not links; Web: a link.
  await expect(p.getByTestId('foot-stores').locator('.hm-badge')).toHaveCount(4);
  for (const [key, devices] of [['play', 'Android'], ['appstore', 'iPhone · iPad · Mac'], ['microsoft', 'Windows']]) {
    const b = p.getByTestId(`foot-store-${key}`);
    expect(await b.evaluate((el) => el.tagName)).toBe('SPAN');
    await expect(b).toHaveAttribute('aria-disabled', 'true');
    expect(await b.getAttribute('href')).toBeNull();
    await expect(b).toContainText(`Coming soon · ${devices}`);
    await expect(b).toHaveAttribute('aria-label', /coming soon/);
  }
  const fweb = p.getByTestId('foot-store-web');
  expect(await fweb.evaluate((el) => el.tagName)).toBe('A');
  await expect(fweb).toHaveAttribute('href', 'http://127.0.0.1:4318/');
  await expect(fweb).not.toContainText('Coming soon');
  const blog = p.getByTestId('foot-blog');
  expect(await blog.evaluate((el) => el.tagName)).toBe('SPAN');
  await expect(blog).toHaveAttribute('aria-disabled', 'true');
});

test('the video: only a picture until Play; then the privacy-enhanced player; Watch the video (hero and footer) scrolls to it', async () => {
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
  await p.getByTestId('foot-video').click();
  await expect(p.getByTestId('home-video-play')).toBeFocused();
  await expect(p.getByTestId('home-video-play')).toBeInViewport();
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
  for (const t of ['home-download', 'home-video', 'home-watch', 'foot-stores', 'foot-video', 'home-nav-download', 'home-sheet-download']) await expect(p.getByTestId(t)).toHaveCount(0);
  await expect(p.getByTestId('home-footer').locator('.hm-badge')).toHaveCount(0);
  await expect(p.getByTestId('foot-github')).toBeVisible();
  await expect(p.getByTestId('home-nav').locator('.hm-nav-i')).toHaveText(['Features', 'How it works', 'Open source']);
  await expect(p.getByTestId('home-features')).toBeVisible();

  const ctx2 = await people.context();
  await ctx2.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { configurable: true, get: () => true }));
  const w = await people.page(ctx2, 'pwa');
  await w.goto(people.q());
  await expect(w.getByTestId('home-download').locator('.hm-stk')).toHaveCount(5);
  await expect(w.getByTestId('store-web')).toHaveCount(0);
  await expect(w.getByTestId('foot-stores').locator('.hm-badge')).toHaveCount(3);
  await expect(w.getByTestId('foot-store-web')).toHaveCount(0);
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
    // Top bar: logo, name, the menu (wide) or ☰ (narrow) and the buttons inside the bar, not overlapping.
    // On phones "I have 24 words" moves into the ☰ sheet.
    const bar = (await p.getByTestId('home-top').boundingBox())!;
    const boxes = [];
    const parts = ['.hm-top .hm-logo', '.hm-brand', '[data-testid=home-open]', ...(phone ? ['[data-testid=home-menu]'] : ['[data-testid=restore]', '[data-testid=home-nav]'])];
    for (const sel of parts) {
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
    await expect(p.getByTestId('restore')).toBeVisible({ visible: !phone });
    await expect(p.getByTestId('home-nav')).toBeVisible({ visible: !phone });
    await expect(p.getByTestId('home-menu')).toBeVisible({ visible: phone });
    // The stickers and the footer's buttons wrap inside the page.
    for (const s of await p.locator('.hm-stk, .hm-badge, .hm-soc, .hm-gh').all()) {
      const b = (await s.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(width);
    }
    // Buttons are at least 40 px tall (touch).
    for (const t of [phone ? 'home-menu' : 'restore', 'home-open', 'home-create', 'make-account']) expect((await p.getByTestId(t).boundingBox())!.height).toBeGreaterThanOrEqual(40);
    // The 7 Follow buttons sit on one line.
    const tops = new Set(await p.locator('.hm-soc').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top))));
    expect(tops.size, 'Follow Vilnek buttons on one line').toBe(1);
    // The bundled pictures (logo, phone, video picture) are decoded and shown.
    await p.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
    await p.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await p.locator('.home img').count()).toBe(4); // top bar logo, phone, video picture, footer logo
    await p.screenshot({ path: `docs/screens/home-${width}.png`, fullPage: true });
  });
}

test('phone menu: ☰ opens a sheet with the menu and "I have 24 words"; it closes on a pick, Escape or a tap outside', async () => {
  const ctx = await people.context({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await people.page(ctx, 'phone');
  await p.goto(people.q());
  const btn = p.getByTestId('home-menu');
  const sheet = p.getByTestId('home-menu-sheet');
  await expect(sheet).toBeHidden();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await btn.click();
  await expect(sheet).toBeVisible();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await expect(btn).toHaveAttribute('aria-label', 'Close the menu');
  await expect(sheet.locator('.hm-sheet-i')).toHaveText(['Features', 'How it works', 'Download', 'Open source']);
  await expect(p.getByTestId('home-sheet-source')).toHaveAttribute('href', 'https://github.com/vilnek/p2p');
  await expect(p.getByTestId('home-menu-restore')).toBeVisible();
  // The sheet is solid and inside the screen.
  const box = (await sheet.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  // Escape closes it and puts the keyboard back on ☰.
  await p.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(btn).toBeFocused();
  // A tap outside closes it.
  await btn.click();
  await expect(sheet).toBeVisible();
  await p.locator('.hm-chips').click(); // plain text below the sheet
  await expect(sheet).toBeHidden();
  // A pick closes it and scrolls there.
  await btn.click();
  await p.getByTestId('home-sheet-features').click();
  await expect(sheet).toBeHidden();
  await expect(p.getByTestId('home-features').locator('h2')).toBeInViewport();
  // "I have 24 words" from the sheet opens the restore screen.
  await p.evaluate(() => window.scrollTo(0, 0));
  await btn.click();
  await p.getByTestId('home-menu-restore').click();
  await expect(p.getByTestId('restore-words')).toBeVisible();
});

test('desktop menu: Features, How it works and Download scroll to their sections', async () => {
  const ctx = await people.context({ viewport: { width: 1280, height: 800 } });
  const p = await people.page(ctx, 'desk');
  await p.goto(people.q());
  for (const [item, sec] of [['features', 'home-features'], ['how', 'home-how'], ['download', 'home-download']]) {
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.getByTestId(`home-nav-${item}`).click();
    await expect(p.getByTestId(sec).locator('h2')).toBeInViewport();
  }
  await expect(p.getByTestId('home-menu-sheet')).toBeHidden();
});
