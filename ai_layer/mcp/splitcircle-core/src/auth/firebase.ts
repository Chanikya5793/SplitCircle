/**
 * firebase.ts — Firebase Admin initialization for token verification.
 *
 * Uses Application Default Credentials on Cloud Run (the attached service
 * account). No key files, no secrets in code (Critical Rule #1).
 */

import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';

let auth: Auth | null = null;

export function getFirebaseAuth(): Auth {
  if (getApps().length === 0) {
    initializeApp({
      credential: applicationDefault(),
      projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID,
    });
  }
  if (!auth) auth = getAuth();
  return auth;
}
