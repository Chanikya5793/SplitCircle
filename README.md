# SplitCircle

SplitCircle is an Expo + React Native + TypeScript application that combines Splitwise-style group expense tracking with WhatsApp-inspired chat and call experiences. It is designed to run on iOS, Android, and web with Firebase providing authentication, Firestore data storage, Storage for receipts, and FCM push notifications.

## Features

- **Authentication** – Email/password plus Google OAuth via Firebase Auth.
- **Groups & Expenses** – Create/join groups, invite via codes, post expenses with equal/custom splits, attach receipts, and track balances.
- **Settlements** – Record payments between members and keep everyone even.
- **Chat** – Real-time 1:1 and group messaging with Firestore listeners, media uploads, and offline queueing.
- **Calls** – Secure audio/video calls built on `react-native-webrtc` with signaling over Firestore.
- **Notifications** – FCM push token registration and foreground handling using `expo-notifications`.
- **Offline-first** – Firestore persistent cache, NetInfo-based offline banner, and optimistic UI updates.

## Project Structure

```
.
├── App.tsx                 # Providers, theming, navigation host
├── src/
│   ├── components/         # Reusable UI widgets (cards, overlays, call controls, etc.)
│   ├── constants/          # Theme + route constants
│   ├── context/            # Auth, Group, Chat providers powered by Firebase
│   ├── firebase/           # Firebase initialization + query helpers
│   ├── hooks/              # Calls, notifications, offline sync
│   ├── models/             # TypeScript interfaces for all entities
│   ├── navigation/         # Stack/tab navigation wiring
│   ├── screens/            # Auth, groups, chat, calls, settings, onboarding
│   ├── services/           # Receipt upload helper
│   └── utils/              # Formatting, currency, permissions, split helpers
├── firestore.rules         # Sample Firestore security rules
├── app.config.ts           # Expo configuration (loads env vars via dotenv)
└── README.md
```

## Prerequisites

- Node.js 18+ and npm 9+
- Expo CLI (`npm install -g expo-cli`) or `npx expo`
- Firebase project with Firestore, Authentication, Storage, and Cloud Messaging enabled
- Google OAuth client IDs (Expo, iOS, Android) for Google sign-in
- For calls: valid HTTPS hosting or Expo Go + tunnel, since WebRTC requires secure origins

## Environment Variables

Environment variables are defined in `.env` (see `.env.example`) and are loaded automatically by `app.config.ts` via `dotenv`.
`app.config.ts` prefers env values, and for legacy compatibility it can fall back to checked-in public defaults with warnings (so builds do not suddenly break).

```bash
EXPO_PUBLIC_FIREBASE_API_KEY=...
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=...
EXPO_PUBLIC_FIREBASE_PROJECT_ID=...
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=...
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
EXPO_PUBLIC_FIREBASE_APP_ID=...
EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID=...
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=...
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=...
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=...
EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=...
EXPO_PUBLIC_LIVEKIT_TOKEN_ENDPOINT=...
EXPO_PUBLIC_GOOGLE_VISION_API_KEY=...
```

Do not place server-only secrets in the Expo `.env` (for example `LIVEKIT_API_SECRET`).
Set backend secrets in Firebase Functions Secret Manager:

```bash
firebase functions:secrets:set LIVEKIT_URL
firebase functions:secrets:set LIVEKIT_API_KEY
firebase functions:secrets:set LIVEKIT_API_SECRET
```

## Installation

```bash
npm install
```

**Important notes:**
- `react-native-svg` is pinned to version `15.12.1` for compatibility with Expo SDK 54 and `react-native-chart-kit`. Do not upgrade without testing chart rendering.

## Running the App

Local development via Expo:

```bash
npm run start
```

Optional platform shortcuts:

```bash
npm run android  # Builds and runs on Android device/emulator
npm run ios      # Builds and runs on iOS device/simulator
npm run web      # Starts web development server
```

**Note on `android` and `ios` scripts:** These use `expo run:android` and `expo run:ios` (instead of `expo start --android/ios`) because the app includes native modules (WebRTC, location services) that require native compilation. This means the commands will build the native app, which takes longer than just starting the Metro bundler. For faster development iterations with Expo Go, use `npm run start` and scan the QR code.

The Metro bundler QR code can be scanned using Expo Go. Ensure your Firebase project allows the configured bundle IDs/package names.

## Firebase Setup

1. Create a Firestore database in **production mode**.
2. Enable Authentication providers: **Email/Password** and **Google**.
3. Create `google-services.json` and `GoogleService-Info.plist` and place them at the project root (paths referenced in `app.config.ts`).
4. Upload placeholder icons in `assets/` or replace them with your own branding.
5. Configure FCM by following the Expo notifications guide and set up server keys for sending pushes.

## Firestore Security Rules

The `firestore.rules` file contains a starter policy that enforces per-user access to their profile and restricts group/chat membership. Deploy it via:

```bash
firebase deploy --only firestore:rules
```

Customize rules to match your compliance requirements before going to production.

## Key Workflows

- **Auth Flow**: `AppNavigator` switches between the auth stack and the main tab navigator based on `AuthContext` state. The auth screens call `useAuth` methods for sign-in/register/reset flows.
- **Groups & Expenses**: `GroupContext` streams Firestore groups for the signed-in user, exposes helpers to create/join groups, add expenses (equal/custom splits), and record settlements. `GroupListScreen` and `GroupDetailsScreen` provide the UI.
- **Chat**: `ChatContext` subscribes to chat threads and message collections; `ChatRoomScreen` renders them with `MessageBubble` and sends messages (text/media) through Firebase Storage + Firestore.
- **Calls**: `useCallManager` wraps WebRTC setup with Firestore signaling documents. `CallLobbyScreen` selects a thread, and `CallSessionScreen` shows the live call with camera/mic toggles.
- **Notifications**: `useNotifications` registers Expo push tokens, updates the user profile, and listens to foreground notification taps.
- **Offline Support**: Firestore persistence plus `useOfflineSync` and `OfflineBanner` keep the UI responsive when the device loses connectivity.

## Testing & Quality

- **Type Safety**: `tsconfig.json` enables `strict` mode.
- **Linting**: Use TypeScript diagnostics (`npx tsc --noEmit`) to catch issues.
- **Expo Doctor**: `npx expo doctor` verifies project health.

## Next Steps

- Build UI for inviting specific contacts into chats.
- Extend receipt uploads with previews and deletion.
- Add background sync tasks for queued chat messages and expenses while offline.
- Harden Firestore rules with granular validations (amount ranges, membership checks, etc.).

Enjoy splitting and chatting with SplitCircle! 🤝
