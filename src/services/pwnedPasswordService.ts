import * as Crypto from 'expo-crypto';

const RANGE_ENDPOINT = 'https://api.pwnedpasswords.com/range';
const REQUEST_TIMEOUT_MS = 12_000;

export interface PwnedPasswordResult {
  exposed: boolean;
  occurrenceCount: number;
  checkedAt: number;
}

export const parsePwnedPasswordRange = (body: string, targetSuffix: string): number => {
  const suffix = targetSuffix.trim().toUpperCase();
  for (const line of body.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    if (line.slice(0, separator).trim().toUpperCase() !== suffix) continue;
    const count = Number(line.slice(separator + 1).trim());
    return Number.isSafeInteger(count) && count > 0 ? count : 0;
  }
  return 0;
};

/**
 * Password hashing and suffix matching happen on this device. Only the first
 * five SHA-1 characters leave; neither the password nor the full hash is
 * persisted, logged, returned by the provider, or sent to ManaSplit.
 */
export async function checkPwnedPassword(
  password: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PwnedPasswordResult> {
  if (!password) throw new Error('Enter a password to check.');
  const digest = (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA1, password)).toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${RANGE_ENDPOINT}/${prefix}`, {
      method: 'GET',
      headers: { 'Add-Padding': 'true' },
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Password exposure service is temporarily unavailable.');
    const occurrenceCount = parsePwnedPasswordRange(await response.text(), suffix);
    return { exposed: occurrenceCount > 0, occurrenceCount, checkedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

