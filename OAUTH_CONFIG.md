# OAuth Configuration Guide

This document explains how to provision and manage Google OAuth credentials for SplitCircle without ever checking sensitive values into Git. Follow the steps below whenever you need to rotate credentials or onboard a new environment.

## Required Credentials

| Purpose | Where it is used | Env var | Notes |
| --- | --- | --- | --- |
| Web/Expo client ID | Expo Go / web auth proxy | `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | Safe to expose to the client, but still keep outside of Git history. |
| Android client ID | Android standalone/dev builds | `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` | Must match the `com.splitcircle.app` package and SHA-1 fingerprint configured in Google Cloud. |
| iOS client ID | iOS standalone/dev builds | `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | Must match the `com.splitcircle.app` bundle ID. |
| OAuth client secret | Server-side token exchange (if needed) | Store in a secret manager (GitHub Actions, 1Password, etc.) | **Never** embed on the client. Not required for the Expo proxy flow used in this app. |

## Provisioning Steps

1. In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials), select the `splitcircle-c9e46` project (or your own fork).
2. Create an **OAuth consent screen** in *Testing* mode with your support email and add authorized domains that host the app.
3. Create three **OAuth Client IDs**:
   - **Web application** – add authorized redirect URIs for Expo (`https://auth.expo.io/@your-username/SplitCircle`) and localhost testing (`http://localhost:19006`).
   - **iOS** – bundle ID `com.splitcircle.app`.
   - **Android** – package `com.splitcircle.app` and SHA-1 fingerprint from your debug keystore (see `keytool -list -keystore ~/.android/debug.keystore`).
4. Copy the resulting IDs (and secret for the web client if you plan to run your own token exchange backend).
5. Update your local `.env` by running:

   ```bash
   cp .env.example .env
   # Then edit .env and paste the new values
   ```

6. Restart `expo start` so the refreshed variables flow through `app.config.ts` -> `Constants.expoConfig.extra` -> `AuthContext`.

## Firebase Alignment

- Ensure **Google** and **Email/Password** providers are enabled in Firebase Auth.
- Confirm the OAuth consent screen is linked to the same Firebase project so tokens are trusted.
- No Firebase config values live in the repo—`app.config.ts` pulls everything from `EXPO_PUBLIC_FIREBASE_*` variables.

## Rotation & Incident Response

1. Revoke the impacted credential in Google Cloud Console.
2. Generate a replacement client ID (and secret if required).
3. Update `.env`, redeploy the Expo app, and rotate any backend secrets (GitHub Actions, Cloud Run, etc.).
4. If a previous commit accidentally contained a secret, use `git filter-repo` or a forced rebase **before** pushing, as demonstrated in this change.

Keeping actual values out of Git ensures GitHub push protection and secret scanning stay green and prevents costly credential leaks.


