import { auth, db } from '@/firebase';
import type { UserProfile } from '@/models';
import { clearLockSession } from '@/services/chatLockService';
import { unregisterCurrentDevice } from '@/services/notificationService';
import { clearCachedProfile, loadCachedProfile, persistProfile } from '@/services/profileCache';
import { setLockedChatIds } from '@/utils/lockedChatRegistry';
import * as Google from 'expo-auth-session/providers/google';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User as FirebaseUser,
} from 'firebase/auth';
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

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
  signInWithEmail: (email: string, password: string) => Promise<void>;
  registerWithEmail: (displayName: string, email: string, password: string) => Promise<void>;
  sendResetLink: (email: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
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

      unsubscribeSnapshot = onSnapshot(docRef, async (docSnap) => {
        if (docSnap.exists()) {
          const payload = buildUserProfile(firebaseUser, docSnap.data() as UserProfile);
          setUser(payload);
          setLoading(false);
          void persistProfile(payload);
        } else {
          // Document doesn't exist yet. 
          // If we are registering, registerWithEmail will create it shortly.
          // But to be safe (and for Google Sign In), we create it if missing.
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

  useEffect(() => {
    const handleGoogleResponse = async () => {
      if (response?.type !== 'success' || !response.authentication?.idToken) {
        if (response?.type === 'error') {
          console.error('Google Auth Error:', response.error);
        }
        return;
      }
      try {
        debugLog('Signing in with Google credential');
        const credential = GoogleAuthProvider.credential(response.authentication.idToken);
        await signInWithCredential(auth, credential);
        debugLog('Google Sign-In successful');
      } catch (error) {
        console.error('Firebase Google Sign-In failed:', error);
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

  const value = useMemo(
    () => ({
      user,
      loading,
      signInWithEmail,
      registerWithEmail,
      sendResetLink,
      signInWithGoogle,
      signOutUser,
    }),
    [loading, user],
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
