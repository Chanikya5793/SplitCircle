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
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? 'AIzaSyA3yq_vlfRdwWTec5EfSCMYo5nnU5-W13Q',
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? 'splitcircle-c9e46.firebaseapp.com',
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? 'splitcircle-c9e46',
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ?? 'splitcircle-c9e46.firebasestorage.app',
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '862098318872',
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? '1:862098318872:web:2ca94c86c3f1aaf697c56d',
  measurementId: process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID ?? 'G-PX13YLM4C',
};

const google: GoogleEnv = {
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '862098318872-01966qr4lhud1iahhqbm5cj6qp4n5l28.apps.googleusercontent.com',
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '862098318872-644i4oatfhphjvem6vl2trvsl9f9ej2i.apps.googleusercontent.com',
  androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '862098318872-86reqka3is943t0sprqbjkqjfhuf0lsd.apps.googleusercontent.com',
};

const config: ExpoConfig = {
  name: 'SplitCircle',
  slug: 'SplitCircle',
  version: '1.0.0',
  owner: 'chanikya6163',
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
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSLocationWhenInUseUsageDescription: 'This app uses your location to share it with your friends in chat.',
      NSLocationAlwaysAndWhenInUseUsageDescription: 'This app uses your location to share it with your friends in chat.',
    },
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
      'ACCESS_COARSE_LOCATION',
      'ACCESS_FINE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
      'com.google.android.c2dm.permission.RECEIVE',
    ],
    config: {
      googleMaps: {
        apiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY,
      },
    },
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
      projectId: '5050e81d-9b1b-4f2b-bc3a-abc457137122',
    },
    firebase,
    google,
  },
};

export default config;
