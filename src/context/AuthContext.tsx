import { auth, db } from '@/firebase';
import type { UserProfile } from '@/models';
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
  displayName: firebaseUser.displayName ?? existing?.displayName ?? '',
  photoURL: firebaseUser.photoURL ?? existing?.photoURL ?? null,  // Must be null, not undefined for Firestore
  groups: existing?.groups ?? [],
  status: 'online',
  createdAt: existing?.createdAt ?? Date.now(),
  updatedAt: Date.now(),
  preferences: existing?.preferences ?? {
    pushEnabled: false,
    emailEnabled: true,
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

    const unsubscribeAuth = onAuthStateChanged(auth, (firebaseUser) => {
      if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = undefined;
      }

      if (!firebaseUser) {
        setUser(null);
        setLoading(false);
        return;
      }

      const docRef = doc(db, 'users', firebaseUser.uid);

      unsubscribeSnapshot = onSnapshot(docRef, async (docSnap) => {
        if (docSnap.exists()) {
          const payload = buildUserProfile(firebaseUser, docSnap.data() as UserProfile);
          setUser(payload);
          setLoading(false);
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
        preferences: { pushEnabled: false, emailEnabled: true },
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
