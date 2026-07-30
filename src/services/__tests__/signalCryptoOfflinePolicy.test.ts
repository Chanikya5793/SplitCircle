import { beforeEach, describe, expect, it, vi } from 'vitest';

const firestore = vi.hoisted(() => ({
  getDocs: vi.fn(() => new Promise<never>(() => undefined)),
}));

vi.mock('@/firebase', () => ({ app: {}, db: {} }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  doc: vi.fn(() => ({})),
  getDoc: vi.fn(),
  getDocs: firestore.getDocs,
}));
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => vi.fn()),
}));
vi.mock('@/services/pairingService', () => ({
  getCurrentDeviceId: vi.fn(async () => 'this-device'),
}));
vi.mock('../../../modules/splitcircle-crypto', () => ({
  bootstrapSignalIdentity: vi.fn(),
  encryptForDevice: vi.fn(),
  decryptFromDevice: vi.fn(),
  establishSession: vi.fn(),
  generatePublishableBundle: vi.fn(),
  hasSession: vi.fn(),
  hasSignalIdentity: vi.fn(),
  isCryptoAvailable: vi.fn(() => true),
  wipeSignalState: vi.fn(),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { __clearAsyncStorageStore } from './mocks/async-storage';
import {
  listSignalDevices,
  persistPairedSignalDevice,
} from '../signalCryptoService';

describe('Signal cache-only nearby policy', () => {
  beforeEach(() => {
    __clearAsyncStorageStore();
    firestore.getDocs.mockClear();
  });

  it('returns durable devices without starting a Firestore request', async () => {
    const durable = [{
      deviceId: 'peer-phone',
      signalDeviceId: 7,
      identityKey: 'public-identity',
    }];
    await AsyncStorage.setItem(
      'splitcircle.signal.deviceList.offline-peer',
      JSON.stringify(durable),
    );

    const devices = await listSignalDevices('offline-peer', 'cache-only');

    expect(devices).toEqual(durable);
    expect(firestore.getDocs).not.toHaveBeenCalled();
  });

  it('moves an explicitly paired installation away from a stale cached owner', async () => {
    await AsyncStorage.setItem(
      'splitcircle.signal.deviceList.old-account',
      JSON.stringify([{
        deviceId: 'reused-phone',
        signalDeviceId: 2,
        identityKey: 'old-key',
      }]),
    );

    await persistPairedSignalDevice({
      userId: 'current-friend',
      deviceId: 'reused-phone',
      signalDeviceId: 7,
      identityKey: 'verified-key',
    });

    await expect(listSignalDevices('old-account', 'cache-only')).resolves.toEqual([]);
    await expect(listSignalDevices('current-friend', 'cache-only')).resolves.toEqual([{
      deviceId: 'reused-phone',
      signalDeviceId: 7,
      identityKey: 'verified-key',
    }]);
  });
});
