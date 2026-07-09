/**
 * chatLockService.ts — per-user locked chats (Face ID / biometric folder).
 *
 * Mirrors archiveService's storage rationale: the lock state lives on
 * `users/{userId}` (self-writable) as a `lockedChats` map (chatId → ms epoch
 * when locked). Locked chats are hidden from the normal list and live behind a
 * biometric-gated "Locked" folder — the unlock itself is always device-local
 * (see biometrics.ts), only the *set* of locked chats syncs across devices.
 *
 * This is deliberately DECOUPLED from the shake privacy-guard (stealth/duress
 * codes) and from the whole-app lock (AppLockContext) — different threat
 * models, different UX.
 */

import { deleteField, doc, updateDoc } from 'firebase/firestore';
import { AppState } from 'react-native';
import { db } from '@/firebase';

// ─────────────────────────────────────────────────────────────
// Unlock session — module-level so EVERY entry point into a locked chat
// (Locked folder, search deep-link, notification tap) shares one biometric
// session instead of each screen keeping its own flag. Cleared when the app
// truly backgrounds; 'inactive' is deliberately excluded because the Face ID
// prompt itself fires 'inactive' and re-arming there would loop the prompt.
//
// The re-arm listener lives HERE (module scope), not in a screen: a
// notification-tap deep link can mount ChatRoomScreen without ChatListScreen
// ever mounting, so no screen can be trusted to own the reset.
// ─────────────────────────────────────────────────────────────

let lockSessionUnlockedAt: number | null = null;

AppState.addEventListener('change', (state) => {
  if (state === 'background') {
    lockSessionUnlockedAt = null;
  }
});

/** Call after a successful biometric unlock of the locked-chats folder. */
export const markLockSessionUnlocked = (): void => {
  lockSessionUnlockedAt = Date.now();
};

/** Re-arm the gate (app backgrounded, sign-out, etc.). */
export const clearLockSession = (): void => {
  lockSessionUnlockedAt = null;
};

/** True while the current foreground session has passed the biometric gate. */
export const isLockSessionUnlocked = (): boolean => lockSessionUnlockedAt !== null;

/** Lock a chat. Locking supersedes pin — a locked chat never renders inline. */
export async function lockChat(userId: string, chatId: string): Promise<void> {
  await updateDoc(doc(db, 'users', userId), {
    [`lockedChats.${chatId}`]: Date.now(),
    [`pinnedChats.${chatId}`]: deleteField(),
    updatedAt: Date.now(),
  });
}

export async function unlockChat(userId: string, chatId: string): Promise<void> {
  await updateDoc(doc(db, 'users', userId), {
    [`lockedChats.${chatId}`]: deleteField(),
    updatedAt: Date.now(),
  });
}
