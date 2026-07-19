/**
 * vitest.services.config.ts — Unit tests for services that touch React Native
 * module boundaries (e.g. nativeCallService's CallKeep event filtering).
 * 'react-native' is aliased to a minimal mock and native-only packages
 * (react-native-callkeep, @livekit/react-native-webrtc) are stubbed via a
 * global require shim installed in the setup file. Run with
 * `npm run test:services`.
 */

import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/services/__tests__/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['src/services/__tests__/setup/nativeCallService.setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'react-native': path.resolve(__dirname, 'src/services/__tests__/mocks/react-native.ts'),
      '@react-native-async-storage/async-storage': path.resolve(
        __dirname,
        'src/services/__tests__/mocks/async-storage.ts'
      ),
      'expo-crypto': path.resolve(__dirname, 'src/services/__tests__/mocks/expo-crypto.ts'),
      'expo-sqlite': path.resolve(__dirname, 'src/services/__tests__/mocks/expo-sqlite.ts'),
    },
  },
});
