import { act, cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cachedProfile = {
  userId: 'offline-user',
  email: 'offline@example.com',
  displayName: 'Offline User',
  photoURL: null,
  groups: [],
  status: 'online',
  archivedGroupIds: [],
  archivedChats: {},
  pinnedChats: {},
  lockedChats: {},
  displayNameChangedAt: null,
  createdAt: 1,
  updatedAt: 1,
  preferences: {
    pushEnabled: false,
    emailEnabled: true,
    messages: true,
    expenses: true,
    settlements: true,
    groupUpdates: true,
    calls: true,
    sounds: true,
    vibration: true,
  },
};

vi.mock('@/firebase', () => ({ auth: {}, db: {} }));
vi.mock('@/services/profileCache', () => ({
  loadCachedProfile: vi.fn(async () => cachedProfile),
  persistProfile: vi.fn(async () => undefined),
  clearCachedProfile: vi.fn(async () => undefined),
}));
vi.mock('@/services/accountDeletionService', () => ({ deleteAccount: vi.fn() }));
vi.mock('@/services/chatLockService', () => ({ clearLockSession: vi.fn() }));
vi.mock('@/services/notificationService', () => ({ unregisterCurrentDevice: vi.fn() }));
vi.mock('@/utils/lockedChatRegistry', () => ({ setLockedChatIds: vi.fn() }));
vi.mock('@/utils/identity', () => ({ needsDisplayName: () => false }));
vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationScope: {},
  AppleAuthenticationCredentialState: { REVOKED: 0 },
}));
vi.mock('expo-auth-session/providers/google', () => ({
  useAuthRequest: () => [null, null, vi.fn()],
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  getRandomBytesAsync: vi.fn(),
  digestStringAsync: vi.fn(),
}));
vi.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: vi.fn() }));
vi.mock('firebase/auth', () => ({
  GoogleAuthProvider: { credential: vi.fn() },
  OAuthProvider: class {},
  createUserWithEmailAndPassword: vi.fn(),
  onAuthStateChanged: vi.fn(() => () => undefined),
  sendPasswordResetEmail: vi.fn(),
  signInWithCredential: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  updateProfile: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn(),
  onSnapshot: vi.fn(),
  runTransaction: vi.fn(),
  serverTimestamp: vi.fn(),
  setDoc: vi.fn(),
}));

import { AuthProvider, useAuth } from '@/context/AuthContext';

const Probe = () => {
  const { loading, user } = useAuth();
  return (
    <div>
      <span>{loading ? 'loading' : 'ready'}</span>
      <span>{user?.userId ?? 'anonymous'}</span>
    </div>
  );
};

describe('AuthProvider network-free cold boot', () => {
  afterEach(cleanup);

  it('releases the loading gate from the durable profile when Firebase never responds', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    expect(screen.getByText('loading')).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('ready')).toBeTruthy();
    expect(screen.getByText('offline-user')).toBeTruthy();
  });
});
