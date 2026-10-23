import { defineConfig } from '@playwright/test';
import base from '../../playwright.config';

// Runs only the group call spec, without starting the app's preview server: the spec serves its own
// test page by request interception, so it can run while another e2e run holds port 4318.
//   npx playwright test --config tests/e2e/group-call.config.ts
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'group-call.spec.ts',
  webServer: undefined,
});
