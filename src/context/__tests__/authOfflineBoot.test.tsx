import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authHarness = vi.hoisted(() => ({
  callback: null as null | ((user: any) => void),
  snapshotCallback: null as null | ((snapshot: any) => void),
  googleRequest: null as null | { clientId: string; codeVerifier: string; redirectUri: string },
  googlePrompt: vi.fn(),
  exchangeCode: vi.fn(),
  googleCredential: vi.fn(),
  signInCredential: vi.fn(),
  signOut: vi.fn(),
  runTransaction: vi.fn(),
}));

const cachedProfile = {
  userId: 'offline-user',
  email: 'offline@example.com',
  displayName: 'Offline User',
  photoURL: null,
  groups: [],
  status: 'online',
  archivedGroupIds: ['previous-account-private-group'],
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
  useAuthRequest: () => [authHarness.googleRequest, null, authHarness.googlePrompt],
  discovery: { tokenEndpoint: 'https://oauth2.googleapis.com/token' },
}));
vi.mock('expo-auth-session', () => ({ exchangeCodeAsync: authHarness.exchangeCode }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  getRandomBytesAsync: vi.fn(),
  digestStringAsync: vi.fn(),
}));
vi.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: vi.fn() }));
vi.mock('firebase/auth', () => ({
  GoogleAuthProvider: { credential: authHarness.googleCredential },
  OAuthProvider: class {},
  createUserWithEmailAndPassword: vi.fn(),
  onAuthStateChanged: vi.fn((_auth, callback) => {
    authHarness.callback = callback;
    return () => undefined;
  }),
  sendPasswordResetEmail: vi.fn(),
  signInWithCredential: authHarness.signInCredential,
  signInWithEmailAndPassword: vi.fn(),
  signOut: authHarness.signOut,
  updateProfile: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn(),
  onSnapshot: vi.fn((_ref, callback) => {
    authHarness.snapshotCallback = callback;
    return () => undefined;
  }),
  runTransaction: authHarness.runTransaction,
  serverTimestamp: vi.fn(),
  setDoc: vi.fn(),
}));

import { AuthProvider, useAuth } from '@/context/AuthContext';

const Probe = () => {
  const { authBusy, loading, sessionAuthenticated, signInWithGoogle, user } = useAuth();
  const [googleResult, setGoogleResult] = React.useState('idle');
  return (
    <div>
      <span>{loading ? 'loading' : 'ready'}</span>
      <span>{user?.userId ?? 'anonymous'}</span>
      <span>{user?.archivedGroupIds?.join(',') || 'no-archives'}</span>
      <span>{sessionAuthenticated ? 'authenticated' : 'cached-only'}</span>
      <span>{authBusy ? 'google-busy' : 'google-idle'}</span>
      <span>{googleResult}</span>
      <button onClick={() => void signInWithGoogle().then(() => setGoogleResult('google-done')).catch((error) => setGoogleResult(error.code ?? 'google-error'))}>
        Google
      </button>
    </div>
  );
};

describe('AuthProvider network-free cold boot', () => {
  beforeEach(() => {
    authHarness.googleRequest = null;
    authHarness.googlePrompt.mockReset();
    authHarness.exchangeCode.mockReset();
    authHarness.googleCredential.mockReset();
    authHarness.signInCredential.mockReset();
    authHarness.signOut.mockReset();
    authHarness.runTransaction.mockReset().mockResolvedValue(undefined);
    authHarness.snapshotCallback = null;
  });
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
    expect(screen.getByText('cached-only')).toBeTruthy();
  });

  it('does not copy one account profile into a different restored Firebase session', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('previous-account-private-group')).toBeTruthy();

    act(() => {
      authHarness.callback?.({
        uid: 'new-account',
        email: 'new@example.com',
        displayName: 'New Account',
        photoURL: null,
      });
    });

    expect(screen.getByText('new-account')).toBeTruthy();
    expect(screen.getByText('no-archives')).toBeTruthy();
    expect(screen.getByText('authenticated')).toBeTruthy();
  });

  it('does not sign out when an unconfirmed first profile write disappears', async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    act(() => {
      authHarness.callback?.({
        uid: 'first-google-login',
        email: 'first@example.com',
        displayName: 'New User',
        photoURL: null,
      });
    });
    expect(authHarness.snapshotCallback).not.toBeNull();

    act(() => {
      authHarness.snapshotCallback?.({
        exists: () => true,
        data: () => ({ userId: 'first-google-login' }),
        metadata: { fromCache: false, hasPendingWrites: true },
      });
    });
    await act(async () => {
      authHarness.snapshotCallback?.({
        exists: () => false,
        metadata: { fromCache: false, hasPendingWrites: false },
      });
      await Promise.resolve();
    });

    expect(authHarness.signOut).not.toHaveBeenCalled();
    expect(authHarness.runTransaction).toHaveBeenCalledTimes(1);
  });

  it('keeps Google busy through code exchange and Firebase sign-in', async () => {
    authHarness.googleRequest = {
      clientId: 'ios-client.apps.googleusercontent.com',
      codeVerifier: 'test-verifier',
      redirectUri: 'com.googleusercontent.apps.ios-client:/oauthredirect',
    };
    authHarness.googlePrompt.mockResolvedValue({ type: 'success', params: { code: 'test-code' } });
    authHarness.exchangeCode.mockResolvedValue({ idToken: 'test-id-token', accessToken: 'test-access-token' });
    const credential = { providerId: 'google.com' };
    authHarness.googleCredential.mockReturnValue(credential);
    let completeFirebase!: () => void;
    authHarness.signInCredential.mockImplementation(() => new Promise<void>((resolve) => { completeFirebase = resolve; }));

    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { fireEvent.click(screen.getByText('Google')); await Promise.resolve(); });

    expect(screen.getByText('google-busy')).toBeTruthy();
    expect(authHarness.exchangeCode).toHaveBeenCalledWith(expect.objectContaining({
      code: 'test-code',
      redirectUri: 'com.googleusercontent.apps.ios-client:/oauthredirect',
      extraParams: { code_verifier: 'test-verifier' },
    }), expect.anything());
    expect(authHarness.signInCredential).toHaveBeenCalledWith(expect.anything(), credential);

    await act(async () => { completeFirebase(); await Promise.resolve(); });
    expect(screen.getByText('google-idle')).toBeTruthy();
    expect(screen.getByText('google-done')).toBeTruthy();
  });

  it('uses the Google request when it becomes ready after the first render', async () => {
    authHarness.googlePrompt.mockResolvedValue({ type: 'cancel' });
    const view = render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { await Promise.resolve(); });
    authHarness.googleRequest = { clientId: 'client', codeVerifier: 'verifier', redirectUri: 'callback:/oauthredirect' };
    view.rerender(<AuthProvider><Probe /></AuthProvider>);

    await act(async () => { fireEvent.click(screen.getByText('Google')); await Promise.resolve(); });
    expect(authHarness.googlePrompt).toHaveBeenCalledTimes(1);
    expect(screen.getByText('google-done')).toBeTruthy();
  });

  it('returns Google exchange failures to the calling screen', async () => {
    authHarness.googleRequest = { clientId: 'client', codeVerifier: 'verifier', redirectUri: 'callback:/oauthredirect' };
    authHarness.googlePrompt.mockResolvedValue({ type: 'success', params: { code: 'test-code' } });
    authHarness.exchangeCode.mockRejectedValue(Object.assign(new Error('Network unavailable'), { code: 'auth/network-request-failed' }));

    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { fireEvent.click(screen.getByText('Google')); await Promise.resolve(); });
    expect(screen.getByText('auth/network-request-failed')).toBeTruthy();
    expect(screen.getByText('google-idle')).toBeTruthy();
    expect(authHarness.signInCredential).not.toHaveBeenCalled();
  });
});
