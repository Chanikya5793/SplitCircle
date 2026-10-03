import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onSnapshot } from 'firebase/firestore';

const mocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  callable: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: mocks.getItem, setItem: mocks.setItem },
}));
vi.mock('@/firebase', () => ({ app: {}, db: {} }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  onSnapshot: vi.fn(),
}));
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => mocks.callable),
}));

import {
  containsSensitiveContent,
  getSensitiveContentFilterEnabled,
  setSensitiveContentFilterEnabled,
  subscribeToBlockedUserIds,
} from '../safetyService';

describe('sensitive content filter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts enabled when the user has not changed it', async () => {
    mocks.getItem.mockResolvedValueOnce(null);
    await expect(getSensitiveContentFilterEnabled()).resolves.toBe(true);
  });

  it('persists an explicit opt-out', async () => {
    await setSensitiveContentFilterEnabled(false);
    expect(mocks.setItem).toHaveBeenCalledWith('@manasplit/safety/filter-sensitive-content', 'false');
  });

  it('flags high-confidence threats and sexual solicitation', () => {
    expect(containsSensitiveContent('you should kill yourself')).toBe(true);
    expect(containsSensitiveContent('send nudes now')).toBe(true);
  });

  it('does not hide ordinary expense conversation', () => {
    expect(containsSensitiveContent('Can you send me $42 for dinner?')).toBe(false);
    expect(containsSensitiveContent('Please pay your share by Friday')).toBe(false);
  });
});

describe('blocked-user subscription', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not deliver a late snapshot or error after the screen unsubscribes', async () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeToBlockedUserIds('me', onChange);
    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce());
    const [, onNext, onError] = vi.mocked(onSnapshot).mock.calls[0] as unknown as [unknown, (snapshot: { docs: { id: string }[] }) => void, (error: Error) => void];
    unsubscribe();
    onNext({ docs: [{ id: 'blocked' }] });
    onError(new Error('late error'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
