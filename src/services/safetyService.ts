import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatMessage } from '@/models';

const FILTER_KEY = '@manasplit/safety/filter-sensitive-content';
export type SafetyReportReason = 'harassment' | 'hate' | 'sexual' | 'violence' | 'scam' | 'other';

const callSafetyFunction = async <Request, Response>(name: string, data: Request): Promise<Response> => {
  const [{ app }, { getFunctions, httpsCallable }] = await Promise.all([
    import('@/firebase'),
    import('firebase/functions'),
  ]);
  const result = await httpsCallable<Request, Response>(getFunctions(app), name)(data);
  return result.data;
};

// Compact, deterministic on-device screen. It deliberately targets explicit
// slurs/threats and solicitation patterns rather than broad sentiment, which
// would hide ordinary financial discussions. Users can disable the filter.
const HIGH_CONFIDENCE_PATTERNS = [
  /\b(kill yourself|kys)\b/i,
  /\b(send nudes?|explicit photos?)\b/i,
  /\b(rape|raping)\b/i,
  /\b(n[i1]gg(?:er|a)s?)\b/i,
  /\b(f[a@]gg(?:ot|ots?)?)\b/i,
  /\b(?:wire|send) (?:me )?(?:gift cards?|crypto).*(?:urgent|immediately|now)\b/i,
];

export const containsSensitiveContent = (text: string): boolean =>
  !!text && HIGH_CONFIDENCE_PATTERNS.some((pattern) => pattern.test(text));

export const getSensitiveContentFilterEnabled = async (): Promise<boolean> => {
  const value = await AsyncStorage.getItem(FILTER_KEY);
  return value !== 'false';
};

export const setSensitiveContentFilterEnabled = async (enabled: boolean): Promise<void> => {
  await AsyncStorage.setItem(FILTER_KEY, enabled ? 'true' : 'false');
};

export const subscribeToBlockedUserIds = (
  uid: string,
  onChange: (ids: Set<string>) => void,
): (() => void) => {
  let unsubscribe: (() => void) | undefined;
  let cancelled = false;
  void Promise.all([import('@/firebase'), import('firebase/firestore')]).then(([{ db }, firestore]) => {
    if (cancelled) return;
    unsubscribe = firestore.onSnapshot(
      firestore.collection(db, 'users', uid, 'blockedUsers'),
      (snapshot) => {
        if (!cancelled) onChange(new Set(snapshot.docs.map((doc) => doc.id)));
      },
      (error) => {
        if (cancelled) return;
        console.error('Blocked-user subscription failed', error);
        onChange(new Set());
      },
    );
  }).catch((error) => {
    if (cancelled) return;
    console.error('Blocked-user subscription setup failed', error);
    onChange(new Set());
  });
  return () => {
    cancelled = true;
    unsubscribe?.();
  };
};

export const setUserBlocked = async (targetUserId: string, blocked: boolean): Promise<void> => {
  await callSafetyFunction<{ targetUserId: string; blocked: boolean }, { blocked: boolean }>(
    'setBlockedUser',
    { targetUserId, blocked },
  );
};

export const reportMessage = async (
  message: ChatMessage,
  reason: SafetyReportReason,
): Promise<string> => {
  const result = await callSafetyFunction<{
    chatId: string;
    messageId: string;
    reportedUserId: string;
    messageType: string;
    excerpt: string;
    reason: SafetyReportReason;
  }, { reportId: string }>('reportSafetyIssue', {
    chatId: message.chatId,
    messageId: message.messageId || message.id,
    reportedUserId: message.senderId,
    messageType: message.type,
    // A report is an explicit user decision to send this limited excerpt to
    // ManaSplit safety staff. Normal messages remain local/transit-only.
    excerpt: (message.content ?? '').slice(0, 500),
    reason,
  });
  return result.reportId;
};
