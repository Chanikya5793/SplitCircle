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

/**
 * Save a call to local history
 */
export const saveCallToHistory = async (entry: CallHistoryEntry): Promise<void> => {
    try {
        const existingData = await AsyncStorage.getItem(CALL_HISTORY_KEY);
        const history: CallHistoryEntry[] = existingData ? JSON.parse(existingData) : [];

        // Check if call already exists (avoid duplicates)
        const existingIndex = history.findIndex(h => h.callId === entry.callId);
        if (existingIndex >= 0) {
            // Update existing entry
            history[existingIndex] = entry;
        } else {
            // Add new entry at the beginning (most recent first)
            history.unshift(entry);
        }

        // Keep only last 100 calls to prevent storage bloat
        const trimmedHistory = history.slice(0, 100);

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
