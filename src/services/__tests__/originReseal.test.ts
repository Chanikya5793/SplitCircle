/**
 * Origin re-seal decisions (ai_layer/docs/33 §2.5, Phase 8).
 *
 * The rule under test is a security boundary, not a feature: a relay that
 * re-seals is forging ciphertext attributed to someone else. The tests are
 * therefore weighted toward everything that must NOT happen.
 */
import { describe, expect, it } from 'vitest';

import { departedDevices, evaluateReseal, type ResealCandidate } from '../mesh/originReseal';
import { MAX_MESH_MESSAGE_AGE_MS } from '../mesh/constants';

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const candidate = (overrides: Partial<ResealCandidate> = {}): ResealCandidate => ({
  originOwned: true,
  recipientDeviceIds: ['dev-a', 'dev-b'],
  wireEnvelope: '{"v":1}',
  createdAt: NOW - 1000,
  ...overrides,
});

describe('evaluateReseal', () => {
  it('re-seals for a device added after the envelope was sealed', () => {
    // The whole point: doc 32 §5e's excluded device finally gets a copy.
    expect(evaluateReseal(candidate(), ['dev-a', 'dev-b', 'dev-new'], NOW)).toEqual({
      reseal: true,
      missingDeviceIds: ['dev-new'],
    });
  });

  it('REFUSES to re-seal anything we relayed rather than authored', () => {
    // A relay minting ciphertext attributed to another sender is forgery.
    // This must hold even when a device is genuinely missing a copy.
    expect(
      evaluateReseal(candidate({ originOwned: false }), ['dev-a', 'dev-new'], NOW),
    ).toEqual({ reseal: false, reason: 'not-origin-owned' });
  });

  it('checks origin ownership BEFORE anything else', () => {
    // Ordering is the guard. A relayed operation that is also expired, also
    // envelope-less, and also missing devices must still fail on ownership,
    // so no future condition can accidentally admit one.
    const relayed = candidate({
      originOwned: false,
      wireEnvelope: undefined,
      createdAt: NOW - SEVEN_DAYS * 2,
    });
    expect(evaluateReseal(relayed, ['dev-new'], NOW)).toEqual({
      reseal: false,
      reason: 'not-origin-owned',
    });
  });

  it('does nothing when every current device already has a copy', () => {
    expect(evaluateReseal(candidate(), ['dev-a', 'dev-b'], NOW)).toEqual({
      reseal: false,
      reason: 'already-covered',
    });
  });

  it('ignores duplicate device ids in the audience', () => {
    expect(evaluateReseal(candidate(), ['dev-a', 'dev-a', 'dev-b'], NOW)).toEqual({
      reseal: false,
      reason: 'already-covered',
    });
  });

  it('refuses to resurrect a message older than the queue window', () => {
    // Otherwise joining a group re-seals every message ever queued — a flood,
    // and a surprise for someone who expected to start from now.
    expect(
      evaluateReseal(candidate({ createdAt: NOW - SEVEN_DAYS - 1 }), ['dev-new'], NOW),
    ).toEqual({ reseal: false, reason: 'too-old' });
  });

  it('has nothing to work from without an envelope', () => {
    expect(
      evaluateReseal(candidate({ wireEnvelope: undefined }), ['dev-new'], NOW),
    ).toEqual({ reseal: false, reason: 'no-envelope' });
  });

  it('treats a missing recipient list as covering nobody', () => {
    // Absent is not "everyone" — assuming otherwise would silently skip the
    // re-seal for every operation predating that field.
    expect(
      evaluateReseal(candidate({ recipientDeviceIds: undefined }), ['dev-a'], NOW),
    ).toEqual({ reseal: true, missingDeviceIds: ['dev-a'] });
  });
});

describe('the shared age constant', () => {
  it('bounds re-seal at exactly the queue window', () => {
    // The constant now lives in a native-free leaf module that BOTH
    // meshMessageProtocol and originReseal import, so there is one source of
    // truth and nothing to drift. This pins the boundary behaviour itself.
    const past = evaluateReseal(
      candidate({ createdAt: NOW - MAX_MESH_MESSAGE_AGE_MS - 1 }), ['dev-new'], NOW,
    );
    const inside = evaluateReseal(
      candidate({ createdAt: NOW - MAX_MESH_MESSAGE_AGE_MS + 1000 }), ['dev-new'], NOW,
    );
    expect(past).toEqual({ reseal: false, reason: 'too-old' });
    expect(inside).toEqual({ reseal: true, missingDeviceIds: ['dev-new'] });
  });
});

describe('departedDevices', () => {
  it('reports devices that left, without implying they should be removed', () => {
    // Reported for diagnostics only. Rewriting an existing envelope would
    // rewrite history, and its ciphertext may already have been delivered.
    expect(departedDevices(candidate(), ['dev-a'])).toEqual(['dev-b']);
  });

  it('is empty when the audience only grew', () => {
    expect(departedDevices(candidate(), ['dev-a', 'dev-b', 'dev-c'])).toEqual([]);
  });
});
