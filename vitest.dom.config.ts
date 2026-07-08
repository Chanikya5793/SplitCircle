/**
 * vitest.dom.config.ts — DOM-rendered component tests (react-native-web +
 * jsdom). Used to verify screen-level fallback behavior that can't run in the
 * pure-node configs: the "not found" timeout states for stale deep links
 * (GroupLoadingFallback, ExpenseDetailsScreen). Run with `npm run test:dom`.
 */

import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    include: ['src/**/__tests__/**/*.test.tsx'],
    environment: 'jsdom',
  },
  resolve: {
    alias: {
      'react-native': 'react-native-web',
      '@': path.resolve(__dirname, 'src'),
    },
  },
  define: {
    __DEV__: 'false',
  },
});
