import AsyncStorage from '@react-native-async-storage/async-storage';

const CALL_HISTORY_KEY = 'call_history';

/**
 * Call history entry stored locally on device
 */
export interface CallHistoryEntry {
    callId: string;
    chatId: string;
    groupId?: string;
    type: 'audio' | 'video';
    direction: 'incoming' | 'outgoing';
    otherParticipant: {
        userId: string;
        displayName: string;
        photoURL?: string;
    };
    startedAt: number;
    endedAt: number;
    duration: number; // seconds
    status: 'completed' | 'missed' | 'declined' | 'failed';
}

// Two persisted records describe the SAME physical call when they started
// within this window. A single call can be saved under two different ids — the
// CallKit-generated placeholder UUID (temp) and the Firebase call-session id
// (final) — so callId equality alone is not enough to dedup.
export const DEDUP_WINDOW_MS = 2000;

/**
 * True when two history records represent the same physical call. Matches on
 * callId (exact) OR same conversation + peer started within DEDUP_WINDOW_MS,
 * which collapses the temp/final id duplicate rows the Recents flow can create.
 */
export const isSameCall = (a: CallHistoryEntry, b: CallHistoryEntry): boolean => {
    if (a.callId === b.callId) return true;
    return (
        a.chatId === b.chatId &&
        a.otherParticipant.userId === b.otherParticipant.userId &&
        Math.abs(a.startedAt - b.startedAt) <= DEDUP_WINDOW_MS
    );
};

/**
 * Merge two records for the same call. Newest wins: the record with the later
 * endedAt reflects the final outcome (status/duration/final id); ties go to the
 * incoming write. The earliest startedAt and the most complete peer identity
 * (real display name + photo) are preserved across both records.
 */
export const mergeCallEntries = (
    existing: CallHistoryEntry,
    incoming: CallHistoryEntry,
): CallHistoryEntry => {
    const newer = incoming.endedAt >= existing.endedAt ? incoming : existing;
    const older = newer === incoming ? existing : incoming;

    const named = [newer, older].find(
        (e) => e.otherParticipant.displayName && e.otherParticipant.displayName !== 'Unknown',
    );
    const withPhoto = [newer, older].find((e) => e.otherParticipant.photoURL);

    return {
        ...older,
        ...newer,
        startedAt: Math.min(existing.startedAt, incoming.startedAt),
        otherParticipant: {
            userId: newer.otherParticipant.userId || older.otherParticipant.userId,
            displayName:
                named?.otherParticipant.displayName || newer.otherParticipant.displayName,
            photoURL: withPhoto?.otherParticipant.photoURL,
        },
    };
};

/**
 * Pure upsert: fold `entry` into `history`, deduping temp/final id duplicates
 * and merging fields (newest wins). Trims to the last 100 records. Extracted so
 * the dedup/merge logic is unit-testable without touching AsyncStorage.
 */
export const upsertCallHistory = (
    history: CallHistoryEntry[],
    entry: CallHistoryEntry,
): CallHistoryEntry[] => {
    const index = history.findIndex((existing) => isSameCall(existing, entry));
    if (index >= 0) {
        // Merge in place so the record keeps its position in the recency-sorted
        // list (a temp record is typically already at the top when the final
        // save lands).
        const next = history.slice();
        next[index] = mergeCallEntries(history[index], entry);
        return next.slice(0, 100);
    }
    // Add new entry at the beginning (most recent first).
    return [entry, ...history].slice(0, 100);
};

/**
 * Save a call to local history
 */
export const saveCallToHistory = async (entry: CallHistoryEntry): Promise<void> => {
    try {
        const existingData = await AsyncStorage.getItem(CALL_HISTORY_KEY);
        const history: CallHistoryEntry[] = existingData ? JSON.parse(existingData) : [];

        const trimmedHistory = upsertCallHistory(history, entry);

        await AsyncStorage.setItem(CALL_HISTORY_KEY, JSON.stringify(trimmedHistory));
        console.log('📞 Call saved to history:', entry.callId);
    } catch (error) {
        console.error('❌ Error saving call to history:', error);
    }
};

/**
 * Get all call history (most recent first)
 */
export const getCallHistory = async (): Promise<CallHistoryEntry[]> => {
    try {
        const data = await AsyncStorage.getItem(CALL_HISTORY_KEY);
        if (!data) return [];
        return JSON.parse(data) as CallHistoryEntry[];
    } catch (error) {
        console.error('❌ Error getting call history:', error);
        return [];
    }
};

/**
 * Get call history for a specific chat
 */
export const getChatCallHistory = async (chatId: string): Promise<CallHistoryEntry[]> => {
    try {
        const history = await getCallHistory();
        return history.filter(h => h.chatId === chatId);
    } catch (error) {
        console.error('❌ Error getting chat call history:', error);
        return [];
    }
};

/**
 * Delete a call from history
 */
export const deleteCallFromHistory = async (callId: string): Promise<void> => {
    try {
        const history = await getCallHistory();
        const filtered = history.filter(h => h.callId !== callId);
        await AsyncStorage.setItem(CALL_HISTORY_KEY, JSON.stringify(filtered));
        console.log('📞 Call deleted from history:', callId);
    } catch (error) {
        console.error('❌ Error deleting call from history:', error);
    }
};

/**
 * Clear all call history
 */
export const clearCallHistory = async (): Promise<void> => {
    try {
        await AsyncStorage.removeItem(CALL_HISTORY_KEY);
        console.log('📞 Call history cleared');
    } catch (error) {
        console.error('❌ Error clearing call history:', error);
    }
};
