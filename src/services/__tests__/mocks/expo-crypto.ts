// Minimal expo-crypto mock for node-side service tests: real SHA-256 via
// node:crypto so hash comparisons behave exactly like the device.
import { createHash } from 'crypto';

export enum CryptoDigestAlgorithm {
  SHA256 = 'SHA-256',
}

export const digestStringAsync = async (_algorithm: unknown, data: string): Promise<string> =>
  createHash('sha256').update(data, 'utf8').digest('hex');
