import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../modules/splitcircle-mesh', () => ({
  sendNearbyPairingEnvelope: vi.fn(async () => 1),
  setNearbyPairingMode: vi.fn(),
}));
vi.mock('../../../modules/splitcircle-crypto', () => ({
  bootstrapSignalIdentity: vi.fn(),
  signWithIdentity: vi.fn(),
  verifyWithIdentity: vi.fn(),
}));
vi.mock('../signalCryptoService', () => ({
  getPersistedSignalDeviceId: vi.fn(),
  persistPairedSignalDevice: vi.fn(),
}));

import {
  createNearbyPairingProof,
  formatNearbyPairingCode,
  normalizeNearbyPairingCode,
} from '../nearbyPairingService';

const proof = (overrides: Partial<Parameters<typeof createNearbyPairingProof>[0]> = {}) =>
  createNearbyPairingProof({
    code: 'ABCD2345',
    pairingId: 'pair',
    challenge: 'challenge',
    hostDeviceId: 'host-device',
    hostIdentityKey: 'host-key',
    peerDeviceId: 'peer-device',
    peerIdentityKey: 'peer-key',
    ...overrides,
  });

describe('nearby pairing protocol bindings', () => {
  it('normalizes a human code without accepting ambiguous punctuation', () => {
    expect(normalizeNearbyPairingCode('ab-cd 2345')).toBe('ABCD2345');
    expect(formatNearbyPairingCode('abcd2345')).toBe('ABCD 2345');
  });

  it('binds proof to the code, challenge, physical devices, and both identity keys', async () => {
    const baseline = await proof();
    await expect(proof({ code: 'ABCD2346' })).resolves.not.toBe(baseline);
    await expect(proof({ challenge: 'other' })).resolves.not.toBe(baseline);
    await expect(proof({ hostDeviceId: 'other-host' })).resolves.not.toBe(baseline);
    await expect(proof({ hostIdentityKey: 'other-host-key' })).resolves.not.toBe(baseline);
    await expect(proof({ peerDeviceId: 'other-peer' })).resolves.not.toBe(baseline);
    await expect(proof({ peerIdentityKey: 'other-peer-key' })).resolves.not.toBe(baseline);
  });
});
