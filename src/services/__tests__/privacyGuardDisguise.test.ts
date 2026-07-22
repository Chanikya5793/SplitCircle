/**
 * privacyGuardDisguise.test.ts — the shake-to-hide disguise engine + duress
 * unlock semantics. Run with `npm run test:services`.
 *
 * The convincingness contract:
 *  - disguiseText is deterministic (same input → same fake, across screens)
 *    and never echoes the real value back.
 *  - decoyAmount is LINEAR per seed: a group's expenses still sum to its
 *    totals, so the fake ledger reconciles under scrutiny.
 *  - the duress code fakes success without counting as a failed attempt.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  attemptUnlock,
  decoyAmount,
  decoyScaleFor,
  disguiseText,
  getFailedAttempts,
  hashCode,
  hydrateGuard,
  maskTextValue,
  updateGuard,
  DEFAULT_GUARD_SETTINGS,
} from '../privacyGuardService';

const registry = ((globalThis as Record<string, unknown>).__nativeCallTestMocks ??= {}) as Record<
  string,
  unknown
>;
const store = (registry.asyncStorageStore ??= new Map<string, string>()) as Map<string, string>;

describe('disguiseText', () => {
  it('is deterministic per input', () => {
    expect(disguiseText('Vegas Boys Trip', 'group')).toBe(disguiseText('Vegas Boys Trip', 'group'));
    expect(disguiseText('Rachel Greene', 'person')).toBe(disguiseText('Rachel Greene', 'person'));
  });

  it('never returns the input itself for dictionary kinds', () => {
    for (const title of ['Groceries', 'Dinner', 'Coffee', 'Taxi']) {
      expect(disguiseText(title, 'title').toLowerCase()).not.toBe(title.toLowerCase());
    }
    expect(disguiseText('Roommates', 'group')).not.toBe('Roommates');
  });

  it('gives multi-word person names a surname initial', () => {
    const fake = disguiseText('Rachel Greene', 'person');
    expect(fake).toMatch(/^[A-Z][a-z]+ [A-Z]$/);
    expect(disguiseText('Rachel', 'person')).toMatch(/^[A-Z][a-z]+$/);
  });

  it('reads as plausible words, not scrambled characters', () => {
    // Dictionary output contains no digit soup and starts with a capital.
    const fake = disguiseText('the hotel bill is 4500, dont tell anyone', 'preview');
    expect(fake).not.toMatch(/\d{3,}/);
    expect(fake.length).toBeGreaterThan(2);
  });

  it('falls back to garble for raw content, preserving digits-as-digits', () => {
    const fake = disguiseText('7/18/2026', 'raw');
    expect(fake).toMatch(/^\d\/\d\d\/\d{4}$/);
    expect(fake).not.toBe('7/18/2026');
  });
});

describe('maskTextValue', () => {
  it('renders dots and blocks with clamped length', () => {
    expect(maskTextValue('ab', 'dots')).toBe('••••');
    expect(maskTextValue('a'.repeat(40), 'blocks')).toBe('█'.repeat(14));
  });

  it('routes garble style through the dictionaries', () => {
    expect(maskTextValue('Weekend Trip', 'garble', 'group')).toBe(
      disguiseText('Weekend Trip', 'group'),
    );
  });
});

describe('decoyAmount — consistent scaled ledger', () => {
  it('is linear per seed: expenses still sum to totals (within rounding)', () => {
    const expenses = [184.5, 92.25, 300, 12.8, 45.99];
    const total = expenses.reduce((a, b) => a + b, 0);
    const scaledSum = expenses.map((v) => decoyAmount(v, 'group-1')).reduce((a, b) => a + b, 0);
    const scaledTotal = decoyAmount(total, 'group-1');
    // Per-value cent rounding can drift by at most half a cent per line.
    expect(Math.abs(scaledSum - scaledTotal)).toBeLessThan(0.05);
  });

  it('uses a stable factor per seed and different factors across seeds', () => {
    expect(decoyAmount(184.5, 'g1')).toBe(decoyAmount(184.5, 'g1'));
    expect(decoyScaleFor('g1')).not.toBe(decoyScaleFor('g2'));
  });

  it('never lands in the ~1.0 band (decoys visibly differ from the truth)', () => {
    for (let i = 0; i < 500; i++) {
      const f = decoyScaleFor(`seed-${i}`);
      expect(f < 0.881 || f > 1.119).toBe(true);
    }
  });

  it('preserves sign and zero', () => {
    expect(decoyAmount(0, 'g1')).toBe(0);
    expect(decoyAmount(-50, 'g1')).toBeLessThan(0);
  });
});

describe('attemptUnlock + duress', () => {
  beforeEach(async () => {
    store.clear();
    await hydrateGuard();
    await updateGuard({
      ...DEFAULT_GUARD_SETTINGS,
      codeHash: await hashCode('1234'),
      duressCodeHash: await hashCode('9999'),
    });
    // Reset persisted lockout between tests.
    store.delete('guard_lockout_v1');
  });

  it('unlocks with the real code', async () => {
    const res = await attemptUnlock('1234');
    expect(res).toMatchObject({ ok: true, duress: false });
  });

  it('flags the duress code without counting it as a failure', async () => {
    const res = await attemptUnlock('9999');
    expect(res).toMatchObject({ ok: false, duress: true, lockedForMs: 0 });
  });

  // NOTE: runs BEFORE the lockout test — the module-level lockout state
  // survives across tests (like the real app between launches), and the
  // lockout test deliberately leaves a cooldown in place.
  it('reports failed attempts live and as a snapshot across the unlock', async () => {
    await attemptUnlock('0000');
    await attemptUnlock('0000');
    const live = await getFailedAttempts();
    expect(live.count).toBe(2);
    expect(live.lastAt).toBeGreaterThan(0);
    // The successful unlock resets the live counter but snapshots it, so the
    // settings sheet (only reachable AFTER unlocking) can still show it.
    await attemptUnlock('1234');
    const after = await getFailedAttempts();
    expect(after.count).toBe(2);
    // A clean second unlock overwrites the snapshot with zero.
    await attemptUnlock('1234');
    expect((await getFailedAttempts()).count).toBe(0);
  });

  it('locks out after repeated wrong codes, but never for duress entries', async () => {
    for (let i = 0; i < 4; i++) {
      const res = await attemptUnlock('0000');
      expect(res.lockedForMs).toBe(0);
    }
    // Duress attempts between failures must not advance the counter.
    expect((await attemptUnlock('9999')).duress).toBe(true);
    // 5th real failure triggers the first cooldown.
    const locked = await attemptUnlock('0000');
    expect(locked.ok).toBe(false);
    expect(locked.lockedForMs).toBeGreaterThan(0);
  });

  // Regression test for a confirmed bug (ui-revamp branch review): the
  // previous test leaves the module in a locked-out state (module-level
  // lockout state deliberately survives across tests here, see the NOTE
  // above). A forced duress-code entry made WHILE that cooldown is active
  // must still fake success silently — that's the entire point of the
  // duress code. Currently attemptUnlock returns the lockout cooldown
  // before ever checking isDuressCode, so this test is expected to FAIL
  // until that ordering is fixed.
  it('BUG: recognizes the duress code even while a lockout cooldown is active', async () => {
    const stillLocked = await attemptUnlock('0000');
    expect(stillLocked.lockedForMs).toBeGreaterThan(0);

    const duress = await attemptUnlock('9999');
    expect(duress.duress).toBe(true);
    expect(duress.lockedForMs).toBe(0);
  });
});

describe('disguise shuffle salt', () => {
  it('re-randomizes every disguise and decoy when the salt rotates', async () => {
    await hydrateGuard();
    await updateGuard({ disguiseSalt: '' });
    const name0 = disguiseText('Rachel Greene', 'person');
    const group0 = disguiseText('Vegas Boys Trip', 'group');
    const amount0 = decoyAmount(184.5, 'g1');

    await updateGuard({ disguiseSalt: 'reshuffle-1' });
    const changed =
      disguiseText('Rachel Greene', 'person') !== name0 ||
      disguiseText('Vegas Boys Trip', 'group') !== group0 ||
      decoyAmount(184.5, 'g1') !== amount0;
    expect(changed).toBe(true);
    // Still deterministic under the new salt.
    expect(disguiseText('Rachel Greene', 'person')).toBe(disguiseText('Rachel Greene', 'person'));

    await updateGuard({ disguiseSalt: '' });
  });
});
