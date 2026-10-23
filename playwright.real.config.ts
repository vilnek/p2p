import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// MANUAL check through the REAL public relays (never part of `npm run test:e2e`).
// Run: npx playwright test --config playwright.real.config.ts
export default defineConfig({ ...base, testDir: 'tests/real', timeout: 180_000, expect: { timeout: 45_000 } });
