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

const defaultPublicEnv: Record<string, string> = {
  EXPO_PUBLIC_FIREBASE_API_KEY: 'AIzaSyA3yq_vlfRdwWTec5EfSCMYo5nnU5-W13Q',
  EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: 'splitcircle-c9e46.firebaseapp.com',
  EXPO_PUBLIC_FIREBASE_PROJECT_ID: 'splitcircle-c9e46',
  EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET: 'splitcircle-c9e46.firebasestorage.app',
  EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '862098318872',
  EXPO_PUBLIC_FIREBASE_APP_ID: '1:862098318872:web:2ca94c86c3f1aaf697c56d',
  EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID: 'G-PX13YLM4C',
  EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: '862098318872-01966qr4lhud1iahhqbm5cj6qp4n5l28.apps.googleusercontent.com',
  EXPO_PUBLIC_GOOGLE_EXPO_CLIENT_ID: '862098318872-01966qr4lhud1iahhqbm5cj6qp4n5l28.apps.googleusercontent.com',
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: '862098318872-644i4oatfhphjvem6vl2trvsl9f9ej2i.apps.googleusercontent.com',
  EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID: '862098318872-86reqka3is943t0sprqbjkqjfhuf0lsd.apps.googleusercontent.com',
};

const readEnv = (
  names: string[],
  options?: { optional?: boolean; allowFallback?: boolean }
): string | undefined => {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  if (options?.allowFallback) {
    for (const name of names) {
      const fallbackValue = defaultPublicEnv[name];
      if (fallbackValue) {
        console.warn(
          `[app.config] ${name} is missing in env. ` +
          `Using checked-in public fallback for local compatibility.`
        );
        return fallbackValue;
      }
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
  apiKey: readEnv(['EXPO_PUBLIC_FIREBASE_API_KEY'], { allowFallback: true })!,
  authDomain: readEnv(['EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN'], { allowFallback: true })!,
  projectId: readEnv(['EXPO_PUBLIC_FIREBASE_PROJECT_ID'], { allowFallback: true })!,
  storageBucket: readEnv(['EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET'], { allowFallback: true })!,
  messagingSenderId: readEnv(['EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID'], { allowFallback: true })!,
  appId: readEnv(['EXPO_PUBLIC_FIREBASE_APP_ID'], { allowFallback: true })!,
  measurementId: readEnv(['EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID'], { optional: true, allowFallback: true }),
};

const google: GoogleEnv = {
  webClientId: readEnv(
    ['EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID', 'EXPO_PUBLIC_GOOGLE_EXPO_CLIENT_ID'],
    { allowFallback: true }
  )!,
  iosClientId: readEnv(['EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID'], { allowFallback: true })!,
  androidClientId: readEnv(['EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID'], { allowFallback: true })!,
};

const googleMapsApiKey = readEnv(['EXPO_PUBLIC_GOOGLE_MAPS_API_KEY'], { optional: true });

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
    backgroundColor: '#101010',
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
      NSLocationAlwaysAndWhenInUseUsageDescription: 'This app uses your location to share live location with your friends.',
      NSLocationAlwaysUsageDescription: 'This app uses your location to share live location with your friends.',
      UIBackgroundModes: ['location', 'fetch'],
    },
    config: {
      googleMapsApiKey,
    },
  },
  android: {
    package: 'com.splitcircle.app',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#101010',
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
        apiKey: googleMapsApiKey,
      },
    },
  },
  web: {
    favicon: './assets/favicon.png',
  },
  plugins: [
    'expo-font',
    'expo-secure-store',
    'expo-web-browser',
    'expo-sqlite',
    'expo-notifications',
    'expo-video',
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission: 'Allow $(PRODUCT_NAME) to use your location to share it with your friends.',
        locationAlwaysPermission: 'Allow $(PRODUCT_NAME) to use your location to share live location.',
        locationWhenInUsePermission: 'Allow $(PRODUCT_NAME) to use your location to share it with your friends.',
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
        isIosBackgroundLocationEnabled: true,
      },
    ],
    ['expo-build-properties', { android: { minSdkVersion: 24 } }],
    '@config-plugins/react-native-webrtc',
    '@livekit/react-native-expo-plugin',
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
