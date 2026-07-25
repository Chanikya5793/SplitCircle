/**
 * Backup passphrase strength assessment (doc 31 §3.5).
 *
 * Pure module — no RN/native imports — so the gate that decides whether a
 * passphrase is acceptable is unit-testable in isolation. That matters more
 * here than usual: decryption happens offline against already-downloaded
 * CKRecords, so nothing rate-limits guessing and this function is the only
 * thing standing between a stolen backup and a brute force.
 */

/**
 * Minimum estimated entropy, in bits. 55 is chosen against the offline threat
 * model rather than a generic password-policy number: below this an attacker
 * with the encrypted blob and commodity GPUs is realistically in range, and no
 * amount of KDF stretching rescues a genuinely weak passphrase.
 */
export const MIN_ENTROPY_BITS = 55;
export const MIN_LENGTH = 12;

export type PassphraseVerdict = 'too-short' | 'weak' | 'fair' | 'strong';

export interface PassphraseAssessment {
  entropyBits: number;
  verdict: PassphraseVerdict;
  /** Hard gate — enrollment must refuse when false. */
  meetsMinimum: boolean;
  /** Specific, actionable reasons; never a bare "too weak". */
  issues: string[];
}

/** Sequences and repeats that inflate naive entropy estimates without adding real work for an attacker. */
const hasObviousPattern = (value: string): boolean => {
  const lower = value.toLowerCase();
  if (/(.)\1{2,}/.test(lower)) return true; // aaa
  if (/(0123|1234|2345|3456|4567|5678|6789|7890)/.test(lower)) return true;
  if (/(abcd|bcde|cdef|defg|efgh|qwer|wert|erty|asdf|sdfg|zxcv)/.test(lower)) return true;
  return false;
};

const COMMON_WORDS = [
  'password', 'passphrase', 'splitcircle', 'manasplit', 'letmein', 'welcome',
  'iloveyou', 'admin', 'qwerty', 'monkey', 'dragon', 'football', 'baseball',
];

/**
 * Estimates entropy as length × log2(charset), then penalises patterns and
 * known words.
 *
 * Deliberately conservative rather than clever: this number gates enrollment,
 * so over-estimating a weak passphrase is the dangerous direction of error.
 */
export const assessPassphrase = (passphrase: string): PassphraseAssessment => {
  const issues: string[] = [];

  if (passphrase.length < MIN_LENGTH) {
    issues.push(`Use at least ${MIN_LENGTH} characters.`);
  }

  let charset = 0;
  if (/[a-z]/.test(passphrase)) charset += 26;
  if (/[A-Z]/.test(passphrase)) charset += 26;
  if (/[0-9]/.test(passphrase)) charset += 10;
  if (/[^A-Za-z0-9]/.test(passphrase)) charset += 33;

  let entropyBits = charset > 0 ? Math.round(passphrase.length * Math.log2(charset)) : 0;

  const lower = passphrase.toLowerCase();
  if (COMMON_WORDS.some((word) => lower.includes(word))) {
    // A dictionary word is close to free for an attacker, so charge most of
    // its apparent contribution back.
    entropyBits = Math.round(entropyBits * 0.5);
    issues.push('Avoid common words or the app name.');
  }
  if (hasObviousPattern(passphrase)) {
    // Charged heavily, not cosmetically: a sequence or repeat collapses the
    // real search space far more than length suggests. Caught by a test where
    // 20 sequential lowercase letters scored 56 bits and would have been
    // ACCEPTED under a gentler penalty.
    entropyBits = Math.round(entropyBits * 0.4);
    issues.push('Avoid repeated characters or keyboard runs.');
  }
  if (charset <= 26 && passphrase.length > 0) {
    // A single character class is guessed with a much smaller alphabet than
    // length × log2(26) implies, so this is a real deduction rather than a
    // hint. Multi-word passphrases keep passing because a space (or any
    // punctuation) widens the charset past this branch.
    entropyBits = Math.round(entropyBits * 0.6);
    issues.push('Mix in capitals, numbers, or symbols — or use several unrelated words.');
  }

  const meetsMinimum = passphrase.length >= MIN_LENGTH && entropyBits >= MIN_ENTROPY_BITS;

  let verdict: PassphraseVerdict;
  if (passphrase.length < MIN_LENGTH) verdict = 'too-short';
  else if (entropyBits < MIN_ENTROPY_BITS) verdict = 'weak';
  else if (entropyBits < 80) verdict = 'fair';
  else verdict = 'strong';

  if (!meetsMinimum && issues.length === 0) {
    issues.push('Make it longer, or combine several unrelated words.');
  }

  return { entropyBits, verdict, meetsMinimum, issues };
};
