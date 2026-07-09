/**
 * lockedChatRegistry.ts — tiny dependency-free snapshot of the signed-in
 * user's locked chat ids.
 *
 * Why it exists: the expo-notifications foreground handler runs in module
 * scope (utils/notifications.ts) with no access to React context, but it must
 * know whether an incoming `message` push belongs to a locked chat so it can
 * keep the banner/alert from flashing the sender on screen. AuthContext keeps
 * this registry in sync with `users/{uid}.lockedChats`.
 *
 * Deliberately has zero imports so it can be consumed from the notification
 * handler without creating a require cycle.
 */

let lockedChatIds: ReadonlySet<string> = new Set();

export const setLockedChatIds = (ids: Iterable<string>): void => {
  lockedChatIds = new Set(ids);
};

export const isChatIdLocked = (chatId: string | null | undefined): boolean =>
  !!chatId && lockedChatIds.has(chatId);
