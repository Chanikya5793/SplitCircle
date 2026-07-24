import type { Expense } from './expense';

export interface GroupMember {
  userId: string;
  displayName: string;
  photoURL?: string;
  role: 'owner' | 'admin' | 'member';
  balance: number;
  /**
   * True when the user is no longer an active group member but is preserved
   * for historical reference (so balances, debts, and chat history can keep
   * resolving their displayName instead of "Unknown"). Members with this flag
   * are stored under `Group.archivedMembers`, never `Group.members`.
   */
  archived?: boolean;
  /** When the member was removed or left, if archived. */
  archivedAt?: number;
  /** How they exited the group. */
  archivedReason?: 'left' | 'removed' | 'account_deleted';
}

export interface Settlement {
  settlementId: string;
  requestId?: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
  createdAt: number;
  note?: string;
  status: 'pending' | 'completed';
}

/**
 * Per-group Money-in-Chat settings (ai_layer/docs/21). Admin-gated; stored on
 * the group doc so every member's client honors the same policy. Absent field
 * (older groups) = all defaults.
 */
export interface MoneyInChatInsightsSettings {
  /** How often the group "wrapped" digest card auto-posts to the chat. */
  digestCadence: 'off' | 'weekly' | 'monthly';
  /** Unusual-spend alerts may post to the chat as quiet cards. */
  anomalyPosts: boolean;
  /** Category-budget-crossed alerts may post to the chat. */
  budgetAlerts: boolean;
  /** Restrict the who-pays fairness meter on stats to admins. */
  fairnessAdminsOnly: boolean;
}

export interface MoneyInChatSettings {
  /** How expenses/settlements surface in the linked chat. */
  autoPost: 'cards' | 'compact' | 'off';
  /** Stale-debt reminder bot. */
  nudges: { enabled: boolean; staleDays: number };
  /** Who may create expenses from the chat surfaces. */
  createFromChat: 'everyone' | 'admins';
  inviteLinks: boolean;
  outwardSharing: boolean;
  /** Stats/insights → chat controls (ai_layer/docs/22). */
  insights: MoneyInChatInsightsSettings;
}

export const DEFAULT_MONEY_IN_CHAT: MoneyInChatSettings = {
  autoPost: 'cards',
  nudges: { enabled: true, staleDays: 7 },
  createFromChat: 'everyone',
  inviteLinks: true,
  outwardSharing: true,
  insights: {
    digestCadence: 'monthly',
    anomalyPosts: false,
    budgetAlerts: true,
    fairnessAdminsOnly: false,
  },
};

/** Merge a (possibly partial/absent) stored value over the defaults. */
export const resolveMoneyInChat = (
  stored?: Partial<MoneyInChatSettings> | null,
): MoneyInChatSettings => ({
  ...DEFAULT_MONEY_IN_CHAT,
  ...(stored ?? {}),
  nudges: { ...DEFAULT_MONEY_IN_CHAT.nudges, ...(stored?.nudges ?? {}) },
  insights: { ...DEFAULT_MONEY_IN_CHAT.insights, ...(stored?.insights ?? {}) },
});

export interface Group {
  groupId: string;
  requestId?: string;
  inviteCode: string;
  name: string;
  /** Group photo (Firebase Storage URL) — set by admins in Group Info. */
  photoURL?: string;
  description?: string;
  currency: string;
  members: GroupMember[];
  /**
   * Members who have left or been removed. Their userId is still referenced
   * by historical expenses and settlements, so we keep their identity here
   * so balance / debt / friend lookups can resolve a real displayName.
   */
  archivedMembers?: GroupMember[];
  memberIds?: string[];
  expenses: Expense[];
  settlements: Settlement[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Money-in-chat policy (admin-set). Absent = DEFAULT_MONEY_IN_CHAT. */
  moneyInChat?: Partial<MoneyInChatSettings>;
  /** Admin-set per-category MONTHLY budgets in the group currency. */
  budgets?: Record<string, number>;
  /**
   * Hidden 2-person ledger backing 1:1 money requests (ai_layer/docs/21) —
   * excluded from the groups list UI but otherwise a normal group.
   */
  hidden?: boolean;
}
