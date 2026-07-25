import { describe, expect, it } from 'vitest';
import { MIN_LENGTH, assessPassphrase } from '../passphraseStrength';

// This gate is the only thing between a stolen backup blob and an offline
// brute force (doc 31 §3.5) — decryption happens against already-downloaded
// CKRecords, so nothing rate-limits guessing. These tests pin the REJECTIONS
// especially: a false "strong" is the dangerous direction of error.
describe('assessPassphrase', () => {
  it('rejects anything shorter than the minimum, however exotic', () => {
    const result = assessPassphrase('aA1!aA1!');
    expect(result.meetsMinimum).toBe(false);
    expect(result.verdict).toBe('too-short');
    expect(result.issues.join(' ')).toContain(String(MIN_LENGTH));
  });

  it('rejects a long but single-charset passphrase', () => {
    // 20 lowercase chars looks long, but the charset is tiny.
    const result = assessPassphrase('abcdefghijklmnopqrst');
    expect(result.meetsMinimum).toBe(false);
    expect(result.issues.some((i) => /capitals|numbers|symbols|words/i.test(i))).toBe(true);
  });

  it('penalises the app name and common words rather than counting their length', () => {
    const withWord = assessPassphrase('SplitCircle99!!xy');
    const without = assessPassphrase('Zqhrvbtm99!!xy');
    expect(withWord.entropyBits).toBeLessThan(without.entropyBits);
    expect(withWord.issues.some((i) => /common words/i.test(i))).toBe(true);
  });

  it('penalises keyboard runs and repeats', () => {
    expect(assessPassphrase('Qwerty12345!!aB').issues.some((i) => /keyboard runs/i.test(i))).toBe(
      true,
    );
    expect(assessPassphrase('Aaa!!!bbbccc111x').issues.some((i) => /repeated/i.test(i))).toBe(true);
  });

  it('accepts a genuinely strong mixed passphrase', () => {
    const result = assessPassphrase('Tr0ub4dor&3-Xylo#Kn');
    expect(result.meetsMinimum).toBe(true);
    expect(['fair', 'strong']).toContain(result.verdict);
  });

  it('accepts a multi-word passphrase, which is the pattern we tell users to use', () => {
    const result = assessPassphrase('correct horse battery staple');
    expect(result.meetsMinimum).toBe(true);
  });

  it('never reports meetsMinimum without also being long enough', () => {
    // Guards the two conditions staying coupled: a future tweak that raises
    // entropy scoring must not let a 6-character passphrase through.
    for (const candidate of ['aA1!', 'Zq9#Xy', 'A1!bC2@dE']) {
      const result = assessPassphrase(candidate);
      expect(result.meetsMinimum).toBe(false);
    }
  });

  it('always explains itself when it rejects', () => {
    for (const candidate of ['short', 'alllowercaseletters', 'password1234']) {
      const result = assessPassphrase(candidate);
      expect(result.meetsMinimum).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });
});
