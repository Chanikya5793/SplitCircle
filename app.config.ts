import type { ExpoConfig } from '@expo/config';
import 'dotenv/config';

type FirebaseEnv = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
};

type GoogleEnv = {
  webClientId: string;
  iosClientId: string;
  androidClientId: string;
};

const firebase: FirebaseEnv = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? '',
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? '',
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ?? '',
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? '',
  measurementId: process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

const google: GoogleEnv = {
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '',
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '',
  androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '',
};

const config: ExpoConfig = {
  name: 'SplitCircle',
  slug: 'SplitCircle',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  newArchEnabled: true,
  scheme: 'splitcircle',
  splash: {
    image: './assets/splash-icon.png',
    resizeMode: 'contain',
    backgroundColor: '#ffffff',
  },
  notification: {
    color: '#1F6FEB',
    iosDisplayInForeground: true,
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.splitcircle.app',
  },
  android: {
    package: 'com.splitcircle.app',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#ffffff',
    },
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
    permissions: [
      'CAMERA',
      'RECORD_AUDIO',
      'INTERNET',
      'READ_EXTERNAL_STORAGE',
      'WRITE_EXTERNAL_STORAGE',
      'READ_MEDIA_IMAGES',
      'READ_MEDIA_VIDEO',
      'READ_MEDIA_AUDIO',
      'VIBRATE',
      'WAKE_LOCK',
      'com.google.android.c2dm.permission.RECEIVE',
    ],
  },
  web: {
    favicon: './assets/favicon.png',
  },
  plugins: [
    'expo-secure-store',
    'expo-web-browser',
    'expo-sqlite',
    'expo-notifications',
    ['expo-build-properties', { android: { minSdkVersion: 24 } }],
    '@config-plugins/react-native-webrtc',
  ],
  extra: {
    eas: {
      projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? '00000000-0000-0000-0000-000000000000',
    },
    firebase,
    google,
  },
};

export default config;
