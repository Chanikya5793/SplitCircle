import { describe, expect, it } from 'vitest';
import {
  normalizeSignalDeviceDirectory,
  resolveSignalDeviceDirectory,
} from '../signalDeviceDirectory';

const durable = [
  { deviceId: 'mini', signalDeviceId: 11, identityKey: 'mini-key' },
  { deviceId: 'pro', signalDeviceId: 12, identityKey: 'old-pro-key' },
];

describe('offline Signal device directory', () => {
  it('keeps durable devices when Firestore returns an empty memory-cache snapshot', () => {
    expect(resolveSignalDeviceDirectory({
      remote: [],
      durable,
      remoteFromCache: true,
    })).toEqual(durable);
  });

  it('merges partial cache results but trusts a server-backed result', () => {
    const partial = [{ deviceId: 'pro', signalDeviceId: 12, identityKey: 'new-pro-key' }];

    expect(resolveSignalDeviceDirectory({
      remote: partial,
      durable,
      remoteFromCache: true,
    })).toEqual([
      durable[0],
      partial[0],
    ]);
    expect(resolveSignalDeviceDirectory({
      remote: partial,
      durable,
      remoteFromCache: false,
    })).toEqual(partial);
  });

  it('rejects malformed durable entries', () => {
    expect(normalizeSignalDeviceDirectory([
      durable[0],
      { deviceId: '', signalDeviceId: 1, identityKey: null },
      { deviceId: 'bad-id', signalDeviceId: Number.NaN, identityKey: null },
      { deviceId: 'bad-key', signalDeviceId: 2, identityKey: 42 },
    ])).toEqual([durable[0]]);
  });
});
