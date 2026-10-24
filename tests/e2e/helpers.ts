import { expect, type Page } from '@playwright/test';

// Design P2: tabs Chats · Calls · Add · Me (rail on wide screens). The chat header shows only the
// name and status; the ID, safety pictures, device and path are in the details (side panel from
// 1200 px wide, otherwise a sheet that opens from the name).

export async function tab(page: Page, t: 'chats' | 'calls' | 'add' | 'me'): Promise<void> {
  await page.getByTestId(`tab-${t}`).click();
}

/** Welcome → Make my account → the 24 words → done. Returns the 24 words. */
export async function makeAccount(page: Page, name: string): Promise<string> {
  if (name) await page.getByTestId('name').fill(name);
  await page.getByTestId('make-account').click();
  const words = await doneWords(page);
  await expect(page.getByTestId('tab-chats')).toBeVisible();
  return words;
}

/** The covered 24 words: hold to show them (they are not on the page otherwise), then let go. */
export async function revealWords(page: Page): Promise<string> {
  const cover = page.getByTestId('words-cover');
  await expect(cover).toBeVisible();
  await expect(page.getByTestId('phrase')).toHaveCount(0); // never shown by default
  await cover.dispatchEvent('pointerdown');
  await expect(page.getByTestId('phrase').locator('li')).toHaveCount(24);
  const words = (await page.getByTestId('phrase').locator('li').allTextContents()).join(' ');
  await cover.dispatchEvent('pointerup');
  await expect(page.getByTestId('phrase')).toHaveCount(0);
  return words;
}

/** "I've written them down" (no check step since 24 Oct 2026). Returns the 24 words. */
export async function doneWords(page: Page): Promise<string> {
  const words = await revealWords(page);
  await page.getByTestId('phrase-done').click();
  return words;
}

/** My 24-digit ID as shown under Me (with spaces). */
export async function myId(page: Page): Promise<string> {
  await tab(page, 'me');
  const id = (await page.getByTestId('my-id').textContent())!;
  expect(id).toMatch(/^\d{4}( \d{4}){5}$/);
  await tab(page, 'chats');
  return id;
}

/** A link opened with no account: one screen, name, Join. */
export async function join(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId('join-screen')).toBeVisible();
  await page.getByTestId('name').fill(name);
  await page.getByTestId('join').click();
}

export async function openInfo(page: Page, timeout = 20_000) {
  await expect(page.getByTestId('peer-name')).toBeVisible({ timeout });
  const info = page.getByTestId('peer-info');
  if (!(await info.isVisible())) await page.getByTestId('peer-info-open').click();
  await expect(info).toBeVisible();
  return info;
}

export async function closeInfo(page: Page): Promise<void> {
  if (await page.locator('.dim').count()) {
    await page.keyboard.press('Escape');
    await expect(page.locator('.dim')).toHaveCount(0);
  }
}

/** The chat is open with this person (their 24-digit ID, as shown). */
export async function expectPeerId(page: Page, id: string, timeout = 20_000): Promise<void> {
  await openInfo(page, timeout);
  await expect(page.getByTestId('peer-id')).toHaveText(id);
  await closeInfo(page);
}

export async function pathLabel(page: Page): Promise<string> {
  await openInfo(page);
  const t = (await page.getByTestId('path-label').textContent()) ?? '';
  await closeInfo(page);
  return t;
}

/** The call's "i" sheet: safety pictures and path. */
export async function openCallInfo(page: Page) {
  await page.getByTestId('call-info').click();
  const sheet = page.getByTestId('call-info-sheet');
  await expect(sheet).toBeVisible();
  return sheet;
}

export async function closeCallInfo(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('call-info-sheet')).toHaveCount(0);
}

export const CONNECTED = /^\d\d:\d\d$/;
export const SAME_WIFI = 'Same Wi-Fi, direct';

/** A link opened while signed in: the app asks first (name, ID, safety pictures), then connects. */
export async function confirmLink(page: Page): Promise<void> {
  await expect(page.getByTestId('link-confirm')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('link-connect').click();
}
