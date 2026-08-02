import AsyncStorage from '@react-native-async-storage/async-storage';

// Per-chat composer drafts persisted in AsyncStorage. Primary use: when a
// missed-call quick reply ultimately fails to send, the text is saved here so
// the user can recover it by opening the chat — even if the "couldn't send"
// notification was dismissed or notifications are disabled entirely.
//
// All functions swallow storage errors (with a warning): a draft is a
// best-effort convenience and must never break the calling flow.

const DRAFT_KEY_PREFIX = 'chatDraft.';

const draftKey = (chatId: string): string => `${DRAFT_KEY_PREFIX}${chatId}`;

export const saveChatDraft = async (
  chatId: string,
  text: string,
): Promise<void> => {
  if (!chatId) {
    return;
  }
  try {
    if (text.trim().length === 0) {
      await AsyncStorage.removeItem(draftKey(chatId));
    } else {
      await AsyncStorage.setItem(draftKey(chatId), text);
    }
  } catch (error) {
    // console.error, not warn: a Release bundle drops console.warn entirely
    // (CLAUDE.md). Swallowing this is correct — a storage hiccup must never
    // break the composer — but a draft that silently vanishes is exactly the
    // "I typed a message and it disappeared" report that is impossible to
    // diagnose without a line in the device log.
    console.error('chatDrafts: failed to save draft', error);
  }
};

export const getChatDraft = async (chatId: string): Promise<string | null> => {
  if (!chatId) {
    return null;
  }
  try {
    const value = await AsyncStorage.getItem(draftKey(chatId));
    return value && value.trim().length > 0 ? value : null;
  } catch (error) {
    console.error('chatDrafts: failed to read draft', error);
    return null;
  }
};

export const clearChatDraft = async (chatId: string): Promise<void> => {
  if (!chatId) {
    return;
  }
  try {
    await AsyncStorage.removeItem(draftKey(chatId));
  } catch (error) {
    console.error('chatDrafts: failed to clear draft', error);
  }
};
