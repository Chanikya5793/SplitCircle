import { auth, db } from '@/firebase';
import type { UserProfile } from '@/models';
import { deleteAccount as deleteAccountCallable } from '@/services/accountDeletionService';
import { clearLockSession } from '@/services/chatLockService';
import { unregisterCurrentDevice } from '@/services/notificationService';
import { clearCachedProfile, loadCachedProfile, persistProfile } from '@/services/profileCache';
import { setLockedChatIds } from '@/utils/lockedChatRegistry';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Google from 'expo-auth-session/providers/google';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  OAuthProvider,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User as FirebaseUser,
} from 'firebase/auth';
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, Settings } from 'react-native';

WebBrowser.maybeCompleteAuthSession();

const debugLog = (...args: unknown[]) => {
  if (__DEV__) {
    console.log(...args);
  }
};

type LegacyManifestExtra = {
  google?: {
    webClientId?: string;
    androidClientId?: string;
    iosClientId?: string;
  };
};

interface AuthContextValue {
  user: UserProfile | null;
  loading: boolean;
  // True while a Google credential exchange is in flight after promptAsync()
  // has already returned — see the state declaration below for why screens
  // need this in addition to their own per-button loading flags.
  authBusy: boolean;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  registerWithEmail: (displayName: string, email: string, password: string) => Promise<void>;
  sendResetLink: (email: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signOutUser: () => Promise<void>;
  deleteAccountAndSignOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const buildUserProfile = (firebaseUser: FirebaseUser, existing?: UserProfile): UserProfile => ({
  userId: firebaseUser.uid,
  email: firebaseUser.email ?? '',
  // App profile (Firestore/cache) wins over the Firebase Auth copy: the photo
  // uploader and name edits write to Firestore, while the Auth profile keeps
  // whatever the provider set at sign-up (e.g. the Google avatar). Auth-first
  // ordering silently reverted every uploaded photo on the next snapshot.
  displayName: existing?.displayName?.trim() || firebaseUser.displayName || '',
  photoURL: existing?.photoURL ?? firebaseUser.photoURL ?? null,  // Must be null, not undefined for Firestore
  groups: existing?.groups ?? [],
  status: 'online',
  // Carry archive state through: buildUserProfile constructs the in-memory
  // profile from a fixed key list, so any field omitted here would be
  // silently stripped from `user` even though Firestore has it.
  archivedGroupIds: existing?.archivedGroupIds ?? [],
  archivedChats: existing?.archivedChats ?? {},
  pinnedChats: existing?.pinnedChats ?? {},
  lockedChats: existing?.lockedChats ?? {},
  createdAt: existing?.createdAt ?? Date.now(),
  updatedAt: Date.now(),
  preferences: existing?.preferences ?? {
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
});

// Sign in with Apple (doc 27): replay-protection nonce. The hashed value goes
// to Apple's authorization request; the raw value goes into the Firebase
// credential — Firebase verifies Apple's response was for THIS raw nonce.
const randomNonce = async (): Promise<{ raw: string; hashed: string }> => {
  const bytes = await Crypto.getRandomBytesAsync(32);
  const raw = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, raw);
  return { raw, hashed };
};

/**
 * Remove undefined values from object before sending to Firestore
 * Firestore doesn't accept undefined as a value
 */
const sanitizeForFirestore = <T extends Record<string, any>>(obj: T): T => {
  const result: Record<string, any> = {};
  for (const key in obj) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result as T;
};

export const AuthProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  // True while a Google credential exchange is in flight. signInWithGoogle()
  // only awaits promptAsync() — the actual signInWithCredential happens in a
  // separate, fire-and-forget effect below — so a caller's own loading flag
  // (e.g. SignInScreen's googleLoading) clears before that exchange finishes,
  // leaving a window where a DIFFERENT sign-in method (Apple, email) can fire
  // concurrently against the same `auth` instance. Screens gate every sign-in
  // trigger on this too, not just their own provider's loading flag.
  const [authBusy, setAuthBusy] = useState(false);
  // Set right after signInWithApple() completes its own credential exchange.
  // Apple's getCredentialStateAsync has been observed returning REVOKED
  // (state 0) for a session that's seconds old — a false positive that
  // otherwise immediately signs the user back out right after a successful
  // sign-in. A one-shot "skip the next check" flag wasn't reliable (React's
  // effect scheduling around the onAuthStateChanged-triggered re-render
  // races with exactly when this gets set, and the AppState listener can
  // also fire its own check independently) — a time-based grace window is
  // robust to that ordering regardless of how many checks fire or when.
  const signedInWithAppleAtRef = useRef<number | null>(null);
  const APPLE_REVOCATION_GRACE_MS = 60_000;

  const legacyExtra = (Constants as unknown as { manifest?: { extra?: LegacyManifestExtra } }).manifest?.extra;
  const googleConfig = Constants.expoConfig?.extra?.google ?? legacyExtra?.google ?? {};

  const [request, response, promptAsync] = Google.useAuthRequest({
    webClientId: googleConfig.webClientId
      ?? process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
      ?? '',
    expoClientId: googleConfig.webClientId
      ?? process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
      ?? process.env.EXPO_PUBLIC_GOOGLE_EXPO_CLIENT_ID
      ?? '',
    androidClientId: googleConfig.androidClientId ?? process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '',
    iosClientId: googleConfig.iosClientId ?? process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '',
  });

  useEffect(() => {
    debugLog(`Google auth request ready: ${Boolean(request)}`);
  }, [request]);

  useEffect(() => {
    let unsubscribeSnapshot: (() => void) | undefined;
    let resolvedFromAuth = false;

    // Hydrate the last-known profile so a cold offline start paints instantly
    // (before onAuthStateChanged resolves). onAuthStateChanged wins below.
    void loadCachedProfile().then((cached) => {
      if (cached && !resolvedFromAuth) {
        setUser((prev) => prev ?? cached);
      }
    });

    const unsubscribeAuth = onAuthStateChanged(auth, (firebaseUser) => {
      resolvedFromAuth = true;
      if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = undefined;
      }

      // Mirror the signed-in uid to NSUserDefaults (same bridge pattern as
      // RNThemeIsDark/PrivacyGuardEnabled) so headless native code — App Intents
      // Siri can invoke without launching JS, see modules/splitcircle-ai/ios/
      // SplitCircleEntities.swift's SplitCircleCurrentUser — knows whose local
      // SQLite index to read. Cleared on sign-out so a headless intent never
      // answers with a previous user's data on a shared/handed-down device.
      if (Platform.OS === 'ios') {
        Settings.set({ SplitCircleCurrentUserId: firebaseUser?.uid ?? '' });
      }

      if (!firebaseUser) {
        setUser(null);
        setLoading(false);
        void clearCachedProfile();
        return;
      }

      // CRITICAL (offline): render immediately from the persisted auth session.
      // The Firestore `users/{uid}` snapshot below only fires online (memory-only
      // cache on RN), so without this the app would hang on the splash forever
      // and never reach the signed-in UI when offline.
      setUser((prev) => {
        const profile = buildUserProfile(firebaseUser, prev ?? undefined);
        void persistProfile(profile);
        return profile;
      });
      setLoading(false);

      const docRef = doc(db, 'users', firebaseUser.uid);
      let hasSeenProfileDoc = false;

      unsubscribeSnapshot = onSnapshot(docRef, async (docSnap) => {
        if (docSnap.exists()) {
          hasSeenProfileDoc = true;
          const payload = buildUserProfile(firebaseUser, docSnap.data() as UserProfile);
          setUser(payload);
          setLoading(false);
          void persistProfile(payload);
        } else if (hasSeenProfileDoc) {
          // The doc existed earlier this session and is now gone — the account
          // was deleted (by this device or another signed-in one; deleteAccount's
          // server-side cascade removes users/{uid} directly). Never recreate it:
          // reflect reality by signing out locally instead.
          void signOut(auth).catch(() => undefined);
        } else {
          // Document has never existed this session — a genuinely new sign-in
          // (registerWithEmail will create it shortly, or this is first-time
          // Google/Apple sign-in). Safe to create if still missing.
          const payload = buildUserProfile(firebaseUser);
          try {
            await setDoc(docRef, sanitizeForFirestore({
              ...payload,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            }));
            // The snapshot listener will fire again after this write.
          } catch (error) {
            console.error('Error creating user profile:', error);
          }
        }
      }, (error) => {
        console.error('Auth snapshot error:', error);
        setLoading(false);
      });
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeSnapshot) unsubscribeSnapshot();
    };
  }, []);

  // Keep the dependency-free locked-chat registry in sync so the module-scope
  // notification handler can suppress foreground banners for locked chats.
  // Also re-arm the biometric lock session whenever the account changes —
  // an unlock must never carry across sign-out/sign-in.
  useEffect(() => {
    setLockedChatIds(Object.keys(user?.lockedChats ?? {}));
    if (!user) {
      clearLockSession();
    }
  }, [user, user?.lockedChats]);

  // Doc 27: a user can revoke Apple sign-in from Settings → Apple ID →
  // Sign-In & Security without ever opening the app. Checking only once on
  // mount/account-change would miss a revocation that happens while the app
  // stays warm in the background — re-check on every foreground too, not
  // just at launch, or a revoked-but-still-running session never gets caught
  // until the process is killed and relaunched.
  useEffect(() => {
    if (Platform.OS !== 'ios' || !user) return;
    const checkAppleRevocation = () => {
      const signedInAt = signedInWithAppleAtRef.current;
      if (signedInAt !== null && Date.now() - signedInAt < APPLE_REVOCATION_GRACE_MS) {
        return;
      }
      const appleLink = auth.currentUser?.providerData.find((p) => p.providerId === 'apple.com');
      if (!appleLink) return;
      AppleAuthentication.getCredentialStateAsync(appleLink.uid)
        .then((state) => {
          if (state === AppleAuthentication.AppleAuthenticationCredentialState.REVOKED) {
            void signOutUser();
          }
        })
        .catch(() => undefined);
    };
    checkAppleRevocation();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkAppleRevocation();
    });
    return () => sub.remove();
  }, [user?.userId]);

  useEffect(() => {
    const handleGoogleResponse = async () => {
      if (response?.type !== 'success' || !response.authentication?.idToken) {
        if (response?.type === 'error') {
          console.error('Google Auth Error:', response.error);
        }
        return;
      }
      setAuthBusy(true);
      try {
        debugLog('Signing in with Google credential');
        const credential = GoogleAuthProvider.credential(response.authentication.idToken);
        await signInWithCredential(auth, credential);
        debugLog('Google Sign-In successful');
      } catch (error) {
        console.error('Firebase Google Sign-In failed:', error);
      } finally {
        setAuthBusy(false);
      }
    };
    handleGoogleResponse();
  }, [response]);

  const signInWithEmail = async (email: string, password: string) => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error: any) {
      console.error('SignIn Error:', error);
      throw error;
    }
  };

  const registerWithEmail = async (displayName: string, email: string, password: string) => {
    try {
      const { user: newUser } = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(newUser, { displayName });
      const docRef = doc(db, 'users', newUser.uid);
      await setDoc(docRef, {
        userId: newUser.uid,
        email,
        displayName,
        photoURL: newUser.photoURL ?? null,
        groups: [],
        status: 'online',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
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
      });
    } catch (error: any) {
      console.error('Registration Error:', error);
      throw error;
    }
  };

  const sendResetLink = async (email: string) => {
    await sendPasswordResetEmail(auth, email);
  };

  const signInWithGoogle = async () => {
    if (!request) {
      throw new Error('Google auth is not configured. Add EXPO_PUBLIC_GOOGLE_* env vars.');
    }
    await promptAsync();
  };

  const signInWithApple = async () => {
    const { raw, hashed } = await randomNonce();
    let credential: AppleAuthentication.AppleAuthenticationCredential;
    try {
      credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: hashed,
      });
    } catch (err: any) {
      if (err?.code === 'ERR_REQUEST_CANCELED') return; // user dismissed — not an error
      throw err;
    }
    if (!credential.identityToken) {
      throw new Error('Apple did not return an identity token.');
    }
    const provider = new OAuthProvider('apple.com');
    const oauthCredential = provider.credential({ idToken: credential.identityToken, rawNonce: raw });
    let signedInUser: FirebaseUser;
    try {
      ({ user: signedInUser } = await signInWithCredential(auth, oauthCredential));
    } catch (err: any) {
      console.error('Firebase Apple Sign-In failed:', err);
      throw err;
    }
    signedInWithAppleAtRef.current = Date.now();

    // First-authorization-only: Apple sends the name exactly once, ever — grab
    // it now or it's gone. `!signedInUser.displayName` guards re-runs.
    const fullName = [credential.fullName?.givenName, credential.fullName?.familyName]
      .filter((part): part is string => Boolean(part?.trim()))
      .join(' ');
    if (fullName && !signedInUser.displayName) {
      await updateProfile(signedInUser, { displayName: fullName });
      // The onAuthStateChanged listener above already raced ahead and may have
      // created users/{uid} via buildUserProfile(firebaseUser) BEFORE this
      // updateProfile() call resolved — at that instant firebaseUser.displayName
      // was still empty, so the doc can get created with displayName: '' and
      // nothing else ever re-syncs it (Apple never sends the name again).
      // Firestore guarantees same-client writes apply in the order they were
      // issued, so this merge — issued only after updateProfile() resolves —
      // deterministically wins over that earlier doc-creation write in every
      // case where the race could otherwise have dropped the name. Best-effort:
      // a failure here shouldn't fail an otherwise-successful sign-in.
      await setDoc(
        doc(db, 'users', signedInUser.uid),
        { displayName: fullName, updatedAt: serverTimestamp() },
        { merge: true },
      ).catch(() => undefined);
    }
  };

  const signOutUser = async () => {
    if (user) {
      try {
        await unregisterCurrentDevice();
      } catch (error) {
        console.warn('Failed to unregister notification device during sign out:', error);
      }
    }
    await signOut(auth);
  };

  const deleteAccountAndSignOut = async () => {
    // Unregister BEFORE the account is gone: deleteAccountCallable's server-side
    // cascade already deletes the notificationDevices subcollection, so calling
    // unregisterCurrentDevice() after it returns would use its Admin-SDK-bypassing
    // set({merge:true}) to resurrect a device doc under a uid that no longer has
    // a user record — an orphan nothing will ever clean up.
    if (user) {
      try {
        await unregisterCurrentDevice();
      } catch (error) {
        console.warn('Failed to unregister notification device during account deletion:', error);
      }
    }
    await deleteAccountCallable();
    await signOut(auth);
  };

  const value = useMemo(
    () => ({
      user,
      loading,
      authBusy,
      signInWithEmail,
      registerWithEmail,
      sendResetLink,
      signInWithGoogle,
      signInWithApple,
      signOutUser,
      deleteAccountAndSignOut,
    }),
    [loading, user, authBusy],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
