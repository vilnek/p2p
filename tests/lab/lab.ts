// Shared helpers for the test lab. Reuses the e2e helpers (read only) and adds fault tools.
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, makeAccount, tab } from '../e2e/helpers';
import type { LabRelay } from './lab-relay';

export { join, makeAccount, tab };

/** One line per measured number, collected for REPORT.md (tests/lab/out/metrics.jsonl). */
export function metric(check: string, data: Record<string, unknown>): void {
  mkdirSync('tests/lab/out', { recursive: true });
  const line = { at: new Date().toISOString(), check, ...data };
  appendFileSync('tests/lab/out/metrics.jsonl', JSON.stringify(line) + '\n');
  console.log('METRIC', JSON.stringify(line));
}

export class Lab {
  readonly contexts: BrowserContext[] = [];
  readonly errors: string[] = [];
  constructor(
    readonly browser: Browser,
    readonly relay: () => LabRelay | { url: string },
  ) {}

  q(extra = ''): string {
    return `/p2p.html?relays=${encodeURIComponent(this.relay().url)}${extra}`;
  }

  async context(options: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
    const ctx = await this.browser.newContext(options);
    this.contexts.push(ctx);
    return ctx;
  }

  async page(ctx?: BrowserContext, label = ''): Promise<Page> {
    const p = await (ctx ?? (await this.context())).newPage();
    p.on('pageerror', (e) => {
      this.errors.push(`${label}: ${e.message}`);
      console.log(label, 'pageerror', e.message);
    });
    p.on('console', (m) => m.type() === 'error' && console.log(label, 'console.error', m.text().slice(0, 300)));
    return p;
  }

  async person(name: string, extra = '', ctxOptions: Parameters<Browser['newContext']>[0] = {}): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await this.context(ctxOptions);
    const page = await this.page(ctx, name);
    await page.goto(this.q(extra));
    await makeAccount(page, name);
    return { ctx, page };
  }

  async close(): Promise<void> {
    for (const c of this.contexts.splice(0)) await c.close().catch(() => undefined);
  }
}

export async function makeInvite(page: Page): Promise<string> {
  await tab(page, 'add');
  await page.getByTestId('share-invite').click();
  await page.getByTestId('make-invite').click();
  return page.getByTestId('invite-link').inputValue();
}

export async function showCard(page: Page): Promise<string> {
  await tab(page, 'add');
  await page.getByTestId('show-my-code').click();
  await expect(page.getByTestId('waiting-scan')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('toggle-text').click();
  return page.getByTestId('code-text').inputValue();
}

export async function paste(page: Page, text: string): Promise<void> {
  await tab(page, 'add');
  await page.getByTestId('paste-their-code').click();
  await page.getByTestId('paste-box').fill(text);
  await page.getByTestId('paste-go').click();
}

export const fragment = (link: string) => `#c=${link.split('#c=')[1]}`;

/** Two people connected through an invite link (A made it, B joined). */
export async function pair(lab: Lab, extraA = '', extraB = extraA, names = ['Asha', 'Ravi']): Promise<{ a: Page; b: Page; actx: BrowserContext; bctx: BrowserContext }> {
  const A = await lab.person(names[0], extraA);
  const link = await makeInvite(A.page);
  const bctx = await lab.context();
  const b = await lab.page(bctx, names[1]);
  await b.goto(`${lab.q(extraB)}${fragment(link)}`);
  await join(b, names[1]);
  await expect(A.page.getByTestId('peer-name')).toHaveText(names[1], { timeout: 30_000 });
  await expect(b.getByTestId('peer-name')).toHaveText(names[0], { timeout: 30_000 });
  return { a: A.page, b, actx: A.ctx, bctx };
}

export async function say(from: Page, text: string): Promise<void> {
  await from.getByTestId('message-input').fill(text);
  await from.getByTestId('send').click();
}

/** Opens the chat with the (only / named) contact from the Chats list. */
export async function openContact(page: Page, name?: string): Promise<void> {
  await tab(page, 'chats');
  const c = name ? page.getByTestId('contact').filter({ hasText: name }) : page.getByTestId('contact');
  await c.first().click();
}

export const testHook = (p: Page, fn: 'drop') => p.evaluate((f) => (window as unknown as { __p2pTest: Record<string, () => void> }).__p2pTest[f](), fn);

/** JS heap of a page (Chrome only, needs --enable-precise-memory-info). */
export const heapMB = (p: Page) => p.evaluate(() => ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576);
