// Minimal expo-crypto mock for node-side service tests: real SHA-256 via
// node:crypto so hash comparisons behave exactly like the device.
import { createHash } from 'crypto';

export enum CryptoDigestAlgorithm {
  SHA1 = 'SHA-1',
  SHA256 = 'SHA-256',
}

export const digestStringAsync = async (algorithm: unknown, data: string): Promise<string> =>
  createHash(algorithm === CryptoDigestAlgorithm.SHA1 ? 'sha1' : 'sha256').update(data, 'utf8').digest('hex');
