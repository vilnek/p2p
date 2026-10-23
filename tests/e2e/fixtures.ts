import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { makeAccount, tab } from './helpers';
import type { MockRelay } from './mock-relay';

/** Contexts made by a test; closed after it. */
export class People {
  readonly contexts: BrowserContext[] = [];
  readonly seen: string[] = [];
  constructor(
    readonly browser: Browser,
    readonly relay: () => MockRelay,
  ) {}

  q(extra = ''): string {
    return `/p2p.html?relays=${encodeURIComponent(this.relay().url)}${extra}`;
  }

  async context(options: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
    const ctx = await this.browser.newContext(options);
    this.contexts.push(ctx);
    return ctx;
  }

  watch(page: Page, label = ''): Page {
    page.on('request', (r) => this.seen.push(r.url()));
    page.on('websocket', (ws) => this.seen.push(ws.url()));
    page.on('pageerror', (e) => console.log(label, 'pageerror', e.message));
    return page;
  }

  async page(ctx?: BrowserContext, label = ''): Promise<Page> {
    return this.watch(await (ctx ?? (await this.context())).newPage(), label);
  }

  /** A person with an account, on Chats. */
  async person(name: string, extra = ''): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await this.context();
    const page = await this.page(ctx, name);
    await page.goto(this.q(extra));
    await makeAccount(page, name);
    return { ctx, page };
  }

  onlyLocal(): void {
    const outside = this.seen.filter((u) => !/^(http:\/\/127\.0\.0\.1:4318\/(p2p\.html([?#].*)?|favicon\.ico)|ws:\/\/127\.0\.0\.1:\d+\/?|blob:.*)$/.test(u));
    expect(outside).toEqual([]);
  }

  async close(): Promise<void> {
    for (const c of this.contexts.splice(0)) await c.close();
  }
}

export async function makeInvite(page: Page): Promise<string> {
  await tab(page, 'add');
  await page.getByTestId('share-invite').click();
  await page.getByTestId('make-invite').click();
  const link = await page.getByTestId('invite-link').inputValue();
  expect(link).toMatch(/^https:\/\/p2p\.vilnek\.in\/#c=[A-Za-z0-9_-]+$/);
  return link;
}

export async function showCard(page: Page): Promise<string> {
  await tab(page, 'add');
  await page.getByTestId('show-my-code').click();
  await expect(page.getByTestId('waiting-scan')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('toggle-text').click();
  return page.getByTestId('code-text').inputValue();
}

export const fragment = (link: string) => `#c=${link.split('#c=')[1]}`;
