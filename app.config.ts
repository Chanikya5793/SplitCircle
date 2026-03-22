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

const readEnv = (
  names: string[],
  options?: { optional?: boolean }
): string | undefined => {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  if (options?.optional) {
    return undefined;
  }

  const label = names.join(' or ');
  throw new Error(
    `[app.config] Missing required env var: ${label}. ` +
    `Copy .env.example to .env and set these values before starting Expo.`
  );
};

const firebase: FirebaseEnv = {
  apiKey: readEnv(['EXPO_PUBLIC_FIREBASE_API_KEY'])!,
  authDomain: readEnv(['EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN'])!,
  projectId: readEnv(['EXPO_PUBLIC_FIREBASE_PROJECT_ID'])!,
  storageBucket: readEnv(['EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET'])!,
  messagingSenderId: readEnv(['EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID'])!,
  appId: readEnv(['EXPO_PUBLIC_FIREBASE_APP_ID'])!,
  measurementId: readEnv(['EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID'], { optional: true }),
};

const google: GoogleEnv = {
  webClientId: readEnv(
    ['EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID', 'EXPO_PUBLIC_GOOGLE_EXPO_CLIENT_ID']
  )!,
  iosClientId: readEnv(['EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID'])!,
  androidClientId: readEnv(['EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID'])!,
};

const googleMapsApiKey = readEnv(['EXPO_PUBLIC_GOOGLE_MAPS_API_KEY'], { optional: true });

const config = {
  name: 'SplitCircle',
  slug: 'SplitCircle',
  version: '0.0.1',
  owner: 'chanikya6163',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  scheme: 'splitcircle',
  splash: {
    image: './assets/splash-icon.png',
    resizeMode: 'cover',
    backgroundColor: '#101010',
  },
  notification: {
    color: '#1F6FEB',
    iosDisplayInForeground: true,
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.splitcircle.app',
    backgroundColor: '#121212',
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSLocationWhenInUseUsageDescription: 'This app uses your location to share it with your friends in chat.',
      UIBackgroundModes: ['fetch', 'remote-notification'],
    },
  },
  android: {
    package: 'com.splitcircle.app',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#101010',
    },
    predictiveBackGestureEnabled: false,
    permissions: [
      'CAMERA',
      'RECORD_AUDIO',
      'READ_MEDIA_IMAGES',
      'READ_MEDIA_VIDEO',
      'READ_MEDIA_AUDIO',
      'VIBRATE',
      'WAKE_LOCK',
      'ACCESS_COARSE_LOCATION',
      'ACCESS_FINE_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
      'com.google.android.c2dm.permission.RECEIVE',
    ],
    config: {
      googleMaps: {
        apiKey: googleMapsApiKey,
      },
    },
  },
  web: {
    favicon: './assets/favicon.png',
  },
  plugins: [
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        resizeMode: 'cover',
        imageWidth: 393,
        backgroundColor: '#101010',
      },
    ],
    'expo-font',
    'expo-secure-store',
    'expo-web-browser',
    'expo-sqlite',
    'expo-notifications',
    'expo-audio',
    'expo-sharing',
    'expo-video',
    [
      'expo-location',
      {
        locationWhenInUsePermission: 'Allow $(PRODUCT_NAME) to use your location to share it with your friends.',
        isAndroidBackgroundLocationEnabled: false,
        isAndroidForegroundServiceEnabled: false,
        isIosBackgroundLocationEnabled: false,
      },
    ],
    ['expo-build-properties', { android: { minSdkVersion: 24 } }],
    '@livekit/react-native-expo-plugin',
  ],
  extra: {
    eas: {
      projectId: '5050e81d-9b1b-4f2b-bc3a-abc457137122',
    },
    firebase,
    google,
  },
} as ExpoConfig;

export default config;
