/**
 * notificationRevoke.ts — pure logic for the "revoke" silent push.
 *
 * When a group/expense/settlement is deleted, the server sends a silent
 * push (content-available on iOS, data-only on Android) carrying
 * `{ type: 'revoke', groupId?/expenseId?/settlementId?/chatId? }` so devices
 * can withdraw stale tray notifications even when the app is killed.
 *
 * The payload the background task receives is wrapped differently per
 * platform (APNs nests custom data under `body`; FCM delivers stringified
 * JSON; expo-notifications adds its own envelope), so this extractor walks
 * the structure tolerantly and returns every revoke filter it finds.
 *
 * Kept free of expo/react-native imports so it runs in the pure node suite.
 */

import type { EntityNotificationFilter } from './notificationEntityMatch';

const MAX_DEPTH = 6;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const parseMaybeJsonObject = (value: string): unknown => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

const toRevokeFilter = (record: Record<string, unknown>): EntityNotificationFilter | null => {
  if (record.type !== 'revoke') {
    return null;
  }

  const filter: EntityNotificationFilter = {};
  const groupId = asString(record.groupId);
  const expenseId = asString(record.expenseId);
  const settlementId = asString(record.settlementId);
  const chatId = asString(record.chatId);

  if (groupId) filter.groupId = groupId;
  if (expenseId) filter.expenseId = expenseId;
  if (settlementId) filter.settlementId = settlementId;
  if (chatId) filter.chatId = chatId;

  return Object.keys(filter).length > 0 ? filter : null;
};

const filterKey = (filter: EntityNotificationFilter): string =>
  [filter.groupId ?? '', filter.expenseId ?? '', filter.settlementId ?? '', filter.chatId ?? ''].join('|');

/**
 * Walks an arbitrary push payload and returns every revoke filter found in
 * it, deduplicated. Depth-limited and never throws — a malformed payload
 * simply yields no filters.
 */
export const extractRevokeFilters = (raw: unknown): EntityNotificationFilter[] => {
  const found = new Map<string, EntityNotificationFilter>();

  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || node === null || node === undefined) {
      return;
    }

    if (typeof node === 'string') {
      const parsed = parseMaybeJsonObject(node);
      if (parsed !== null) {
        visit(parsed, depth + 1);
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const entry of node) {
        visit(entry, depth + 1);
      }
      return;
    }

    if (typeof node !== 'object') {
      return;
    }

    const record = node as Record<string, unknown>;
    const filter = toRevokeFilter(record);
    if (filter) {
      found.set(filterKey(filter), filter);
    }

    for (const value of Object.values(record)) {
      visit(value, depth + 1);
    }
  };

  visit(raw, 0);
  return Array.from(found.values());
};
