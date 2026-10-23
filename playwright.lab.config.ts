import { defineConfig } from '@playwright/test';

// TEST LAB (tests/lab/REPORT.md). Builds the CURRENT source into tests/lab/.dist and serves it on its
// own port, so lab runs never clash with other people's `npm run test:e2e` on 4318.
//   npm run lab                          lab checks (faults, big files, groups, WebKit) + soak
//   npm run lab -- --project e2e         the normal e2e suite, through the lab's port proxy
//   npm run lab:real                     lab checks through the REAL public relays (manual)
// Switches: LAB_NOBUILD=1 serves the last lab build; LAB_SOAK_MIN (default 30); LAB_BIG_MB (2048).
const LAB_PORT = Number(process.env.LAB_PORT || 4327);
const PROXY_PORT = Number(process.env.LAB_PROXY_PORT || 4328);
const chromeArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--enable-usermedia-screen-capturing', '--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'];
const DIST = process.env.LAB_DIST || 'tests/lab/.dist';
const build = process.env.LAB_NOBUILD ? '' : `npx vite build --outDir ${DIST} --emptyOutDir --logLevel warn && `;

export default defineConfig({
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['json', { outputFile: process.env.LAB_JSON || 'tests/lab/out/last-run.json' }]],
  outputDir: process.env.LAB_RESULTS || 'tests/lab/out/results',
  use: {
    channel: 'chrome',
    headless: true,
    permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
    launchOptions: { args: chromeArgs },
  },
  projects: [
    {
      name: 'lab',
      testDir: 'tests/lab',
      testMatch: /^(?!.*(soak|real-|android)).*\.spec\.ts$/,
      use: { baseURL: `http://127.0.0.1:${LAB_PORT}` },
    },
    { name: 'soak', testDir: 'tests/lab', testMatch: /soak\.spec\.ts$/, timeout: 0, use: { baseURL: `http://127.0.0.1:${LAB_PORT}` } },
    { name: 'real', testDir: 'tests/lab', testMatch: /real-.*\.spec\.ts$/, timeout: 600_000, expect: { timeout: 60_000 }, use: { baseURL: `http://127.0.0.1:${LAB_PORT}` } },
    {
      // The project's own e2e suite, unchanged, reached as 127.0.0.1:4318 through the port proxy.
      name: 'e2e',
      testDir: 'tests/e2e',
      timeout: 120_000,
      use: {
        baseURL: 'http://127.0.0.1:4318',
        proxy: { server: `http://127.0.0.1:${PROXY_PORT}`, bypass: '<-loopback>' },
      },
    },
  ],
  webServer: [
    {
      command: `${build}npx vite preview --outDir ${DIST} --port ${LAB_PORT} --strictPort`,
      url: `http://127.0.0.1:${LAB_PORT}/p2p.html`,
      reuseExistingServer: !!process.env.LAB_REUSE,
      timeout: 300_000,
    },
    {
      command: `node tests/lab/port-proxy.mjs`,
      port: PROXY_PORT,
      env: { LAB_PORT: String(LAB_PORT), LAB_PROXY_PORT: String(PROXY_PORT) },
      reuseExistingServer: !!process.env.LAB_REUSE,
      timeout: 20_000,
    },
  ],
});
