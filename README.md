# SplitCircle (ManaSplit)

Splitwise + WhatsApp + FaceTime in one app: group expense tracking with 11 split
methods (equal → itemized receipts → time-based → gamified roulette), real-time chat,
and native audio/video calls. Expo SDK 55 · React Native 0.83 · TypeScript strict ·
iOS-first (ships to the App Store as **ManaSplit**).

Local-first by design: messages and call history live on the device; Firebase RTDB is
only an ephemeral transit queue; Firestore holds metadata (profiles, groups, expenses).
Calls are RTDB signaling + LiveKit media + CallKit/PushKit system UI.

**Docs:** [CLAUDE.md](CLAUDE.md) architecture DNA, commands, gotchas ·
[DESIGN.md](DESIGN.md) binding UI rules · [OPS.md](OPS.md) shipping, credentials,
calling infra.

## Setup

```bash
npm install
cp .env.example .env      # fill EXPO_PUBLIC_* values — see OPS.md
cd ios && pod install && cd ..
```

Requires Node 18+, Xcode with the iOS 26 SDK, a Firebase project (Auth with
Email/Password + Google, Firestore, RTDB, Storage), and a LiveKit project. Server
secrets go to Firebase Functions Secret Manager, never the repo (OPS.md).

## Run

```bash
npm run start   # Metro (Expo)
npm run ios     # native dev build to simulator/device (native modules require this)
```

Backend: `cd functions && npm run build && firebase deploy --only functions` and
`firebase deploy --only firestore:rules` after rule changes.

## Ship

```bash
npm run ship:ios   # local production build + headless App Store Connect delivery
```

## Layout

```
src/
  components/   UI kit (components/ui), BillSplit editor, call controls, chat widgets
  context/      Auth, Group, Chat, Call, Theme, AppLock providers
  screens/      auth, groups, expenses, chat, calls, settings, search
  services/     local storage, call/voip services, wallpapers, split history, AI
  theme/        token system (single theme source)
functions/      Cloud Functions (voip push, call lifecycle, cleanup reapers)
ios/            native project (UIScene lifecycle — keep intact)
patches/        patch-package diffs (must stay applied)
```

## Quality

```bash
npx tsc --noEmit    # strict typecheck
npx expo doctor     # project health
```
