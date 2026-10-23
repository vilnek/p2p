import { expect, test } from '@playwright/test';

const NO_RELAY = 'relays=' + encodeURIComponent('ws://127.0.0.1:9');

test('start animation shows over the first screen, then removes itself; tap skips it', async ({ page }) => {
  await page.goto(`/p2p.html?splash=1&${NO_RELAY}`); // ?splash=1 forces it in an automated browser
  const splash = page.locator('#p2p-splash');
  await expect(splash).toBeVisible();
  await expect(page.getByTestId('make-account')).toBeAttached(); // the first screen loads underneath
  await expect(splash).toHaveCount(0, { timeout: 6000 }); // gone after ~3 s
  await expect(page.getByTestId('make-account')).toBeVisible();

  await page.goto(`/p2p.html?splash=1&${NO_RELAY}`);
  await page.locator('#p2p-splash').click();
  await expect(page.locator('#p2p-splash')).toHaveCount(0, { timeout: 1500 });

  await page.goto(`/p2p.html?${NO_RELAY}`); // automated browser: skipped at once
  await expect(page.locator('#p2p-splash')).toHaveCount(0);
});
