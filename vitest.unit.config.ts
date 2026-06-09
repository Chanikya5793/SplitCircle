/**
 * vitest.unit.config.ts — App-side PURE unit tests (no React Native runtime).
 * Scoped to logic that imports no native/RN modules: the on-device smart-split
 * recommender and the splitcircle-ai JS fallbacks. Run with `npm run test:unit`.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/utils/__tests__/**/*.test.ts',
      'modules/splitcircle-ai/src/__tests__/**/*.test.ts',
    ],
    environment: 'node',
  },
});
