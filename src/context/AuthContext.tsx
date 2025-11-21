import { auth, db } from '@/firebase';
import type { UserProfile } from '@/models';
import * as Google from 'expo-auth-session/providers/google';
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
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

WebBrowser.maybeCompleteAuthSession();

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
  photoURL: firebaseUser.photoURL ?? existing?.photoURL,
  groups: existing?.groups ?? [],
  status: 'online',
  createdAt: existing?.createdAt ?? Date.now(),
  updatedAt: Date.now(),
  preferences: existing?.preferences ?? {
    pushEnabled: false,
    emailEnabled: true,
  },
});

export const AuthProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const [request, response, promptAsync] = Google.useAuthRequest({
    expoClientId: process.env.EXPO_PUBLIC_GOOGLE_EXPO_CLIENT_ID ?? '',
    androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '',
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? 'mock_ios_client_id',
  });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        setUser(null);
        setLoading(false);
        return;
      }

      const docRef = doc(db, 'users', firebaseUser.uid);
      const snapshot = await getDoc(docRef);
      const payload = buildUserProfile(firebaseUser, snapshot.data() as UserProfile | undefined);
      if (!snapshot.exists()) {
        await setDoc(docRef, {
          ...payload,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      setUser(payload);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const handleGoogleResponse = async () => {
      if (response?.type !== 'success' || !response.authentication?.idToken) {
        return;
      }
      const credential = GoogleAuthProvider.credential(response.authentication.idToken);
      await signInWithCredential(auth, credential);
    };
    handleGoogleResponse();
  }, [response]);

  const signInWithEmail = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  };

  const registerWithEmail = async (displayName: string, email: string, password: string) => {
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
