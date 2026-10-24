import { defineConfig } from '@playwright/test';

// Two browser contexts talk to each other through the built dist/p2p.html.
// Uses the installed Google Chrome (channel "chrome") with fake camera and microphone.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4318',
    channel: process.env.PW_CHANNEL || 'chrome',
    headless: true,
    permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
    launchOptions: {
      // Fake camera / microphone, and screen sharing picks the whole screen without a dialog.
      // On the CI runner (Linux, no ".local" name lookup) Chrome's hidden local addresses can't be reached,
      // so two test browsers on one machine sometimes can't connect directly: show the real local address there.
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--enable-usermedia-screen-capturing', '--autoplay-policy=no-user-gesture-required',
        ...(process.env.CI ? ['--disable-features=WebRtcHideLocalIpsWithMdns'] : [])],
    },
  },
  webServer: {
    command: 'npx vite preview --port 4318 --strictPort',
    url: 'http://127.0.0.1:4318/p2p.html',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
