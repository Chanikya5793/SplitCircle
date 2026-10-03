const UINT32_RANGE = 0x1_0000_0000;

function secureRandomUint32(): number {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('Secure randomness is unavailable');
  }

  const value = new Uint32Array(1);
  globalThis.crypto.getRandomValues(value);
  return value[0];
}

/** Cryptographically secure random float in the half-open range [0, 1). */
export function secureRandomFloat(): number {
  return secureRandomUint32() / UINT32_RANGE;
}

/**
 * Cryptographically secure integer in [0, maxExclusive).
 * Rejection sampling avoids modulo bias when the range does not divide 2^32.
 */
export function secureRandomInt(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > UINT32_RANGE) {
    throw new RangeError('maxExclusive must be a positive safe integer no greater than 2^32');
  }

  const unbiasedLimit = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
  let value: number;
  do {
    value = secureRandomUint32();
  } while (value >= unbiasedLimit);

  return value % maxExclusive;
}
