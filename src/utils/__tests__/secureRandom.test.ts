import { secureRandomFloat, secureRandomInt } from '@/utils/secureRandom';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('secureRandom', () => {
  it('uses crypto.getRandomValues without falling back to Math.random', () => {
    const values = [0xffff_ffff, 5];
    const getRandomValues = vi.fn((target: Uint32Array) => {
      target[0] = values.shift() ?? 0;
      return target;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const mathRandom = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be used');
    });

    // 0xffffffff is rejected for a range of 10; the next unbiased value wins.
    expect(secureRandomInt(10)).toBe(5);
    expect(getRandomValues).toHaveBeenCalledTimes(2);
    expect(mathRandom).not.toHaveBeenCalled();
  });

  it('returns a half-open float and fails closed when secure randomness is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (target: Uint32Array) => {
        target[0] = 0x8000_0000;
        return target;
      },
    });
    expect(secureRandomFloat()).toBe(0.5);

    vi.stubGlobal('crypto', undefined);
    expect(() => secureRandomInt(2)).toThrow('Secure randomness is unavailable');
  });
});
