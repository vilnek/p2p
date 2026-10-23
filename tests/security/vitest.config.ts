// Security proof-of-concept tests (SECURITY_REVIEW_2026-10.md). They are EXPECTED TO FAIL while the
// bug each one describes exists. Kept out of `npm test` on purpose; run with:
//   npx vitest run --config tests/security/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/security/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    root: new URL('../..', import.meta.url).pathname,
  },
});
