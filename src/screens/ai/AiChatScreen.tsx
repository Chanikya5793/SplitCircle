/**
 * AiChatScreen — conversational AI assistant for a group.
 *
 * Multi-turn chat that can ANSWER (exact, deterministic) and ACT (add expense,
 * record settle-up) — every action is shown as a confirmation card and only
 * runs via the app's normal `GroupContext` writes after the user taps Confirm.
 * Questions are answered on-device with no model; open-ended chat uses Apple
 * Intelligence when available. The text box supports the iOS keyboard's
 * built-in dictation mic for voice input.
 */

import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { GuardedScreen } from '@/components/ui';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { Group } from '@/models';
import type { ExpenseAiSource } from '@/services/aiService';
import { processAssistantTurn, type ConversationState, type ProposedAction } from '@/services/assistantService';
import { buildFactsBlock } from '@/services/onDeviceAiService';
import { noteTurn, thumbsDown, thumbsUp } from '@/services/aiFeedbackService';
import { prewarmOnDeviceModel } from '../../../modules/splitcircle-ai';
import { FEEDBACK_REASON_LABELS, type FeedbackReason } from '@/utils/aiFeedback';
import {
  activateChatThread,
  deleteChatThread,
  listChatThreads,
  loadChatSession,
  newChatThread,
  saveChatSession,
  type ChatThreadSummary,
} from '@/services/chatSession';
import type { NavTarget } from '@/utils/assistantChat';
import { formatCurrency } from '@/utils/currency';
import { lightHaptic, mediumHaptic, successHaptic } from '@/utils/haptics';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useHeaderHeight } from '@react-navigation/elements';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Keyboard, KeyboardAvoidingView, Platform, StyleSheet, TouchableOpacity, View } from 'react-native';
import { ActivityIndicator, Icon, Text, TextInput } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface AiChatScreenProps {
  group: Group;
  initialQuestion?: string;
}

type ActionState = 'pending' | 'done' | 'cancelled';

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sources?: ExpenseAiSource[];
  action?: ProposedAction;
  actionState?: ActionState;
  /** Tappable quick replies offered by the assistant. */
  choices?: string[];
  /** True when this bubble is an agentic ask-back (doc 24 clarify). */
  clarify?: boolean;
  /** Stated reading under mild ambiguity — small caption under the answer. */
  assumption?: string;
}

const GREETING = (name: string): ChatMsg => ({
  id: 'greeting',
  role: 'assistant',
  text: `Hi! Ask me about ${name}'s spending and balances, or tell me to add an expense or settle up.`,
});

const QUICK_PROMPTS = [
  'How much did I spend on food?',
  'Show our settle-up',
  'Add $20 lunch, split equally',
  'Summarize this month',
];

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const AiChatScreen = ({ group, initialQuestion }: AiChatScreenProps) => {
  const { theme, isDark } = useTheme();
  const { user } = useAuth();
  const { addExpense, settleUp, deleteExpense, updateExpense, deleteSettlement, updateGroupBudgets } = useGroups();
  // P5: the group's chat id unlocks the on-device-only chat_search tool.
  const { threads: chatThreads } = useChat();
  const groupChatId = useMemo(
    () => chatThreads.find((t) => t.groupId === group.groupId)?.chatId,
    [chatThreads, group.groupId],
  );
  const navigation = useNavigation<any>();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const currentUserId = user?.userId ?? group.members[0]?.userId ?? '';
  const listRef = useRef<FlatList<ChatMsg>>(null);

  const routeFor = (t: NavTarget): { route: string; params: Record<string, unknown> } | null => {
    switch (t) {
      case 'settlements':
        return { route: ROUTES.APP.SETTLEMENTS, params: { groupId: group.groupId } };
      case 'stats':
        return { route: ROUTES.APP.GROUP_STATS, params: { groupId: group.groupId, backTitle: group.name } };
      case 'bills':
        return { route: ROUTES.APP.RECURRING_BILLS, params: { groupId: group.groupId, backTitle: group.name } };
      case 'add_expense':
        return { route: ROUTES.APP.ADD_EXPENSE, params: { groupId: group.groupId } };
      case 'group_info':
        return { route: ROUTES.APP.GROUP_INFO, params: { groupId: group.groupId, initialTitle: 'Group Info', backTitle: group.name } };
      default:
        return null;
    }
  };

  const [messages, setMessages] = useState<ChatMsg[]>([GREETING(group.name)]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // P2 live turn feedback: the loop's status line, then streamed narration.
  const [pending, setPending] = useState<{ status?: string; partial?: string } | null>(null);
  // Doc 25 flywheel: per-message thumb state ('ask' = reason chips showing).
  const [feedback, setFeedback] = useState<Record<string, 'up' | 'ask' | 'down'>>({});
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Conversation memory (slot-filling draft / last proposed action), carried
  // across turns and persisted per group so the thread survives navigation.
  const stateRef = useRef<ConversationState>({});
  const hydrated = useRef(false);

  const persist = useCallback(
    (msgs: ChatMsg[]) => {
      void saveChatSession(group.groupId, msgs, stateRef.current);
    },
    [group.groupId],
  );

  // Live mirror of `messages` for non-reactive reads (the agentic thread view).
  const messagesRef = useRef<ChatMsg[]>([]);

  // Auto-follow guard (same rule as the insights overlay): streaming growth
  // follows only while pinned near the bottom; appends re-engage following.
  const nearBottom = useRef(true);

  // The keyboard already occupies the home-indicator safe area, so the input
  // bar's resting bottom margin (which clears that area when closed) must
  // drop to a plain gap while the keyboard is up — otherwise it stacks with
  // KeyboardAvoidingView's own padding and leaves a dead gap above the keyboard.
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  // Scoped to focus (not a bare mount-effect): AiChatScreen stays mounted
  // under whatever screen gets pushed on top of it (no freezeOnBlur on this
  // stack), so an unscoped listener would react to a keyboard opened on a
  // totally different, foregrounded screen and leave this one's flag stuck.
  useFocusEffect(
    useCallback(() => {
      const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
      const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
      const subs = [
        Keyboard.addListener(showEvent, () => setKeyboardVisible(true)),
        Keyboard.addListener(hideEvent, () => setKeyboardVisible(false)),
      ];
      return () => {
        subs.forEach((s) => s.remove());
        setKeyboardVisible(false);
      };
    }, []),
  );

  const append = useCallback(
    (msg: ChatMsg) => {
      setMessages((prev) => {
        const next = [...prev, msg];
        messagesRef.current = next;
        persist(next);
        return next;
      });
      nearBottom.current = true;
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    },
    [persist],
  );

  // Doc 25: warm the model on entry so the first turn skips the cold-load.
  useEffect(() => {
    prewarmOnDeviceModel();
  }, []);

  // Restore the persisted conversation for this group on first mount.
  useEffect(() => {
    let active = true;
    void loadChatSession<ChatMsg>(group.groupId).then((saved) => {
      if (!active || hydrated.current) return;
      hydrated.current = true;
      if (saved && saved.messages.length > 0) {
        // Drop any stale pending confirm cards from the previous session.
        const restored = saved.messages.map((m) =>
          m.action && m.actionState === 'pending' ? { ...m, actionState: 'cancelled' as ActionState } : m,
        );
        messagesRef.current = restored;
        setMessages(restored);
        stateRef.current = { ...saved.state, pending: undefined, lastProposed: undefined };
        requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
      }
    });
    return () => {
      active = false;
    };
  }, [group.groupId]);

  const send = useCallback(
    async (raw?: string) => {
      const text = (raw ?? input).trim();
      if (!text || busy) return;
      Keyboard.dismiss();
      mediumHaptic();
      append({ id: uid(), role: 'user', text });
      setInput('');
      setBusy(true);
      try {
        // Doc 24: hand the pipeline this chat as a thread view (messages BEFORE
        // this turn — the new text rides as userText) + a compact facts blob.
        const prior = messagesRef.current;
        const agentic = {
          thread: {
            threadId: `assistant-live-${group.groupId}`,
            surface: 'assistant',
            scope: group.groupId,
            title: '',
            createdAt: 0,
            updatedAt: Date.now(),
            messages: prior.map((m) => ({
              id: m.id,
              role: m.role === 'user' ? ('user' as const) : m.clarify ? ('clarify' as const) : ('assistant' as const),
              text: m.text,
              createdAt: 0,
            })),
          },
          facts: buildFactsBlock(group, currentUserId),
          chatId: groupChatId,
          onStatus: (line: string) => setPending((p) => ({ ...p, status: line })),
          onDelta: (partial: string) => setPending({ partial }),
        };
        setPending({ status: 'Thinking…' });
        const turn = await processAssistantTurn(text, group, currentUserId, stateRef.current, agentic);
        stateRef.current = turn.state;
        const replyId = uid();
        append({
          id: replyId,
          role: 'assistant',
          text: turn.reply,
          sources: turn.sources,
          action: turn.action,
          actionState: turn.action ? 'pending' : undefined,
          choices: turn.choices,
          clarify: turn.clarify,
          assumption: turn.assumption,
        });
        // Doc 25: register the turn snapshot so a later 👎 can capture it.
        noteTurn(replyId, turn.trace);
      } catch (err) {
        append({ id: uid(), role: 'assistant', text: err instanceof Error ? err.message : 'Something went wrong. Try again.' });
      } finally {
        setBusy(false);
        setPending(null);
      }
    },
    [append, busy, currentUserId, group, groupChatId, input],
  );

  // ── Thread history (doc 23) ───────────────────────────────────────────────

  const resetToGreeting = useCallback(() => {
    stateRef.current = {};
    setMessages([GREETING(group.name)]);
  }, [group.name]);

  const toggleHistory = useCallback(async () => {
    lightHaptic();
    if (!historyOpen) setThreads(await listChatThreads(group.groupId));
    setHistoryOpen((v) => !v);
  }, [group.groupId, historyOpen]);

  const startNewThread = useCallback(async () => {
    lightHaptic();
    await newChatThread(group.groupId);
    resetToGreeting();
    setHistoryOpen(false);
  }, [group.groupId, resetToGreeting]);

  const switchThread = useCallback(
    async (threadId: string) => {
      lightHaptic();
      const loaded = await activateChatThread<ChatMsg>(group.groupId, threadId);
      if (loaded && loaded.messages.length > 0) {
        // Same restore rule as mount: stale confirm cards retire.
        setMessages(
          loaded.messages.map((m) =>
            m.action && m.actionState === 'pending' ? { ...m, actionState: 'cancelled' as ActionState } : m,
          ),
        );
        stateRef.current = { ...loaded.state, pending: undefined, lastProposed: undefined };
      } else {
        resetToGreeting();
      }
      setHistoryOpen(false);
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
    },
    [group.groupId, resetToGreeting],
  );

  const removeThread = useCallback(
    async (threadId: string) => {
      lightHaptic();
      const wasActive = threads[0]?.threadId === threadId;
      await deleteChatThread(group.groupId, threadId);
      setThreads(await listChatThreads(group.groupId));
      if (wasActive) {
        const next = await loadChatSession<ChatMsg>(group.groupId);
        if (next && next.messages.length > 0) {
          setMessages(next.messages);
          stateRef.current = { ...next.state, pending: undefined, lastProposed: undefined };
        } else {
          resetToGreeting();
        }
      }
    },
    [group.groupId, resetToGreeting, threads],
  );

  // Header controls: history + new thread.
  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerRight}>
          <TouchableOpacity
            onPress={() => void toggleHistory()}
            style={styles.headerIcon}
            accessibilityRole="button"
            accessibilityLabel="Conversation history"
          >
            <Icon source="history" size={22} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => void startNewThread()}
            style={styles.headerIcon}
            accessibilityRole="button"
            accessibilityLabel="New conversation"
          >
            <Icon source="plus" size={24} color={theme.colors.primary} />
          </TouchableOpacity>
        </View>
      ),
    });
  }, [navigation, theme.colors.primary, toggleHistory, startNewThread]);

  // Auto-send a prefilled question (e.g. from the donated Siri activity).
  const didAutoSend = useRef(false);
  useEffect(() => {
    if (initialQuestion && !didAutoSend.current) {
      didAutoSend.current = true;
      void send(initialQuestion);
    }
  }, [initialQuestion, send]);

  const setActionState = (id: string, actionState: ActionState) => {
    // Resolving a proposal clears the "last proposed" memory so the next message
    // isn't treated as a tweak to an already-handled card.
    if (actionState !== 'pending') stateRef.current = { ...stateRef.current, lastProposed: undefined };
    setMessages((prev) => {
      const next = prev.map((m) => (m.id === id ? { ...m, actionState } : m));
      persist(next);
      return next;
    });
  };

  const openTarget = (msg: ChatMsg, target: NavTarget) => {
    setActionState(msg.id, 'done');
    const r = routeFor(target);
    if (r) navigation.navigate(r.route, r.params);
  };

  // Tap a citation → open that expense's details (the RAG "cite" step made actionable).
  const openSource = (s: ExpenseAiSource) => {
    if (!s.expenseId) return;
    lightHaptic();
    navigation.navigate(ROUTES.APP.EXPENSE_DETAILS, {
      groupId: s.groupId || group.groupId,
      expenseId: s.expenseId,
      expenseTitle: s.title,
      backTitle: group.name,
    });
  };

  const confirmAction = async (msg: ChatMsg) => {
    const a = msg.action;
    if (!a || a.type === 'navigate' || busy) return;
    setBusy(true);
    try {
      let ok: string;
      if (a.type === 'add_expense') {
        await addExpense(group.groupId, a.expense, undefined, undefined, uid());
        ok = '✓ Expense added.';
      } else if (a.type === 'settle_up') {
        await settleUp(group.groupId, a.settlement, uid());
        ok = '✓ Settlement recorded.';
      } else if (a.type === 'edit_expense') {
        await updateExpense(group.groupId, a.expense, undefined, undefined, uid());
        ok = '✓ Expense updated.';
      } else if (a.type === 'delete_settlement') {
        await deleteSettlement(group.groupId, a.settlementId);
        ok = '✓ Settlement deleted.';
      } else if (a.type === 'set_budget') {
        const next = { ...(group.budgets ?? {}) };
        if (a.amount > 0) next[a.category] = a.amount;
        else delete next[a.category];
        await updateGroupBudgets(group.groupId, next);
        ok = a.amount > 0 ? '✓ Budget set.' : '✓ Budget removed.';
      } else {
        await deleteExpense(group.groupId, a.expenseId);
        ok = '✓ Expense deleted.';
      }
      successHaptic();
      setActionState(msg.id, 'done');
      append({ id: uid(), role: 'assistant', text: ok });
    } catch (err) {
      append({ id: uid(), role: 'assistant', text: `Couldn't complete that: ${err instanceof Error ? err.message : 'unknown error'}.` });
    } finally {
      setBusy(false);
    }
  };

  // Doc 25: 👍 records sentiment; 👎 opens reason chips → local eval fixture.
  const onThumb = (msg: ChatMsg, up: boolean) => {
    lightHaptic();
    if (up) {
      setFeedback((s) => ({ ...s, [msg.id]: 'up' }));
      void thumbsUp(msg.id);
    } else {
      setFeedback((s) => ({ ...s, [msg.id]: 'ask' }));
    }
  };

  const onFeedbackReason = (msg: ChatMsg, reason?: FeedbackReason) => {
    lightHaptic();
    setFeedback((s) => ({ ...s, [msg.id]: 'down' }));
    const list = messagesRef.current;
    const idx = list.findIndex((m) => m.id === msg.id);
    const prevUser = idx > 0 ? [...list.slice(0, idx)].reverse().find((m) => m.role === 'user') : undefined;
    void thumbsDown(msg.id, reason, {
      surface: 'assistant',
      scope: group.groupId,
      userText: prevUser?.text ?? '',
      replyText: msg.text,
    });
  };

  const renderItem = ({ item }: { item: ChatMsg }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[styles.row, { justifyContent: isUser ? 'flex-end' : 'flex-start' }]}>
        <GlassView role="floating"
          style={[
            styles.bubble,
            isUser
              ? { backgroundColor: theme.colors.primary, borderTopRightRadius: 4 }
              : { borderTopLeftRadius: 4 },
          ]}
        >
          <Text style={{ color: isUser ? theme.colors.onPrimary : theme.colors.onSurface, lineHeight: 20 }}>{item.text}</Text>

          {!isUser && !!item.assumption ? (
            <Text
              variant="labelSmall"
              style={{ color: theme.colors.onSurfaceVariant, fontSize: 10, marginTop: 4, fontStyle: 'italic' }}
            >
              {item.assumption}
            </Text>
          ) : null}

          {item.sources && item.sources.length > 0 ? (
            <View style={styles.sources}>
              {item.sources.map((s, i) => (
                <TouchableOpacity
                  key={`${s.expenseId}-${i}`}
                  style={styles.sourceRow}
                  onPress={() => openSource(s)}
                  disabled={!s.expenseId}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${s.title ?? 'expense'}`}
                >
                  <Text variant="bodySmall" style={{ color: theme.colors.primary, fontWeight: '700' }}>[{i + 1}]</Text>
                  <Text variant="bodySmall" style={{ flex: 1, color: theme.colors.onSurface }}>
                    {s.title ?? 'Expense'}{s.category ? ` · ${s.category}` : ''}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    {formatCurrency(s.amount, s.currency ?? group.currency)}
                  </Text>
                  {s.expenseId ? (
                    <Icon source="chevron-right" size={16} color={theme.colors.onSurfaceVariant} />
                  ) : null}
                </TouchableOpacity>
              ))}
            </View>
          ) : null}

          {!isUser && item.choices && item.choices.length > 0 ? (
            <View style={styles.choices}>
              {item.choices.map((c) => (
                <TouchableOpacity
                  key={c}
                  onPress={() => send(c)}
                  disabled={busy}
                  style={[styles.choiceChip, { borderColor: theme.colors.primary }]}
                  accessibilityRole="button"
                  accessibilityLabel={c}
                >
                  <Text variant="labelMedium" style={{ color: theme.colors.primary, fontWeight: '700' }}>{c}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}

          {/* Doc 25 flywheel: thumbs → reason chips → local eval fixture. */}
          {!isUser && item.id !== 'greeting' ? (
            feedback[item.id] === 'ask' ? (
              <View style={styles.choices}>
                {(Object.keys(FEEDBACK_REASON_LABELS) as FeedbackReason[]).map((r) => (
                  <TouchableOpacity
                    key={r}
                    onPress={() => onFeedbackReason(item, r)}
                    style={[styles.choiceChip, { borderColor: theme.colors.primary }]}
                    accessibilityRole="button"
                    accessibilityLabel={FEEDBACK_REASON_LABELS[r]}
                  >
                    <Text variant="labelMedium" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                      {FEEDBACK_REASON_LABELS[r]}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : feedback[item.id] === 'down' ? (
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, fontSize: 10, marginTop: 4 }}>
                Noted — added to AI evals
              </Text>
            ) : (
              <View style={styles.thumbRow}>
                <TouchableOpacity onPress={() => onThumb(item, true)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Good answer">
                  <Icon
                    source={feedback[item.id] === 'up' ? 'thumb-up' : 'thumb-up-outline'}
                    size={13}
                    color={feedback[item.id] === 'up' ? theme.colors.primary : theme.colors.onSurfaceVariant}
                  />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => onThumb(item, false)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Bad answer">
                  <Icon source="thumb-down-outline" size={13} color={theme.colors.onSurfaceVariant} />
                </TouchableOpacity>
              </View>
            )
          ) : null}

          {item.action && item.actionState === 'pending' ? (
            item.action.type === 'navigate' ? (
              <View style={[styles.actionCard, { borderColor: theme.colors.outline }]}>
                <View style={styles.actionButtons}>
                  <TouchableOpacity onPress={() => setActionState(item.id, 'cancelled')} style={[styles.actionBtn, { borderColor: theme.colors.outline }]}>
                    <Text style={{ color: theme.colors.onSurfaceVariant, fontWeight: '700' }}>Not now</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => openTarget(item, (item.action as { target: NavTarget }).target)} style={[styles.actionBtn, { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary }]}>
                    <Text style={{ color: theme.colors.onPrimary, fontWeight: '700' }}>Open {item.action.summary}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <View style={[styles.actionCard, { borderColor: theme.colors.outline }]}>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurface, marginBottom: 10, fontWeight: '600' }}>
                  {item.action.summary}
                </Text>
                <View style={styles.actionButtons}>
                  <TouchableOpacity onPress={() => setActionState(item.id, 'cancelled')} style={[styles.actionBtn, { borderColor: theme.colors.outline }]} disabled={busy}>
                    <Text style={{ color: theme.colors.onSurfaceVariant, fontWeight: '700' }}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => confirmAction(item)}
                    style={[styles.actionBtn, { backgroundColor: 'destructive' in item.action && item.action.destructive ? theme.colors.error : theme.colors.primary, borderColor: 'transparent' }]}
                    disabled={busy}
                  >
                    <Text style={{ color: 'destructive' in item.action && item.action.destructive ? theme.colors.onError : theme.colors.onPrimary, fontWeight: '700' }}>{'destructive' in item.action && item.action.destructive ? 'Delete' : 'Confirm'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )
          ) : null}
          {item.action && item.actionState === 'cancelled' ? (
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, fontStyle: 'italic' }}>Cancelled.</Text>
          ) : null}
        </GlassView>
      </View>
    );
  };

  return (
    <LiquidBackground>
      <GuardedScreen target="expenses" label="Assistant hidden" duressBehavior="blank" duressLabel="No conversations yet.">
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        {historyOpen && (
          <GlassView role="floating" style={[styles.historyPanel, { top: headerHeight + 4 }]}>
            {threads.length === 0 ? (
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, padding: 14 }}>
                No conversations yet.
              </Text>
            ) : (
              threads.map((t, i) => (
                <View
                  key={t.threadId}
                  style={[
                    styles.historyRow,
                    { borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.06)' },
                  ]}
                >
                  <TouchableOpacity
                    style={styles.historyMain}
                    onPress={() => void switchThread(t.threadId)}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${t.title}`}
                  >
                    <Text
                      variant="labelMedium"
                      numberOfLines={1}
                      style={{
                        color: i === 0 ? theme.colors.primary : theme.colors.onSurface,
                        fontWeight: '600',
                      }}
                    >
                      {t.title}
                    </Text>
                    <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      {new Date(t.updatedAt).toLocaleDateString()} · {t.messageCount} messages
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => void removeThread(t.threadId)}
                    style={styles.historyDelete}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${t.title}`}
                  >
                    <Icon source="trash-can-outline" size={18} color={theme.colors.onSurfaceVariant} />
                  </TouchableOpacity>
                </View>
              ))
            )}
          </GlassView>
        )}
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={renderItem}
          contentContainerStyle={[styles.list, { paddingTop: headerHeight + 8 }]}
          keyboardShouldPersistTaps="handled"
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
          }}
          scrollEventThrottle={64}
          onContentSizeChange={() => {
            if (nearBottom.current) listRef.current?.scrollToEnd({ animated: false });
          }}
          ListFooterComponent={
            busy ? (
              <View style={[styles.row, { justifyContent: 'flex-start' }]}>
                <GlassView role="floating" style={[styles.bubble, { borderTopLeftRadius: 4 }]}>
                  {pending?.partial ? (
                    <Text style={{ color: theme.colors.onSurface, lineHeight: 20 }}>{pending.partial}</Text>
                  ) : (
                    <View style={styles.pendingRow}>
                      <ActivityIndicator size="small" color={theme.colors.primary} />
                      {!!pending?.status && (
                        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                          {pending.status}
                        </Text>
                      )}
                    </View>
                  )}
                </GlassView>
              </View>
            ) : null
          }
        />

        {messages.length <= 1 ? (
          <View style={styles.quickRow}>
            {QUICK_PROMPTS.map((p) => (
              <TouchableOpacity key={p} onPress={() => send(p)} style={[styles.quickChip, { backgroundColor: theme.colors.secondaryContainer }]}>
                <Text variant="labelSmall" style={{ color: theme.colors.onSecondaryContainer }}>{p}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        <GlassView role="floating"
          style={[styles.inputBarShell, { marginBottom: keyboardVisible ? 6 : Math.max(insets.bottom, 10) }]}
          contentStyle={styles.inputBarRow}
        >
          <TextInput
            mode="flat"
            value={input}
            onChangeText={setInput}
            placeholder="Ask, add an expense, or settle up…  (tap the keyboard mic to speak)"
            multiline
            underlineColor="transparent"
            activeUnderlineColor="transparent"
            // iOS ties the caret and the text-selection highlight to the same
            // tintColor, so a fully opaque accent behind selected onSurface
            // text fails WCAG contrast — a translucent tint keeps the caret
            // clearly visible while letting selected text stay legible.
            selectionColor={`${theme.colors.primary}66`}
            style={styles.textInput}
            onSubmitEditing={() => send()}
            blurOnSubmit
          />
          <TouchableOpacity onPress={() => send()} disabled={busy || !input.trim()} style={styles.sendBtn} accessibilityLabel="Send">
            <Icon source="arrow-up-circle" size={34} color={input.trim() && !busy ? theme.colors.primary : theme.colors.onSurfaceVariant} />
          </TouchableOpacity>
        </GlassView>
      </KeyboardAvoidingView>
    </GuardedScreen>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerRight: { flexDirection: 'row' },
  headerIcon: { padding: 6 },
  historyPanel: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 20,
    borderRadius: 16,
    overflow: 'hidden',
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  historyMain: { flex: 1, minWidth: 0, paddingVertical: 11, paddingHorizontal: 14, gap: 1 },
  historyDelete: { padding: 12 },
  list: { padding: 12, gap: 10, paddingBottom: 8 },
  row: { flexDirection: 'row', width: '100%' },
  bubble: { maxWidth: '88%', borderRadius: 18, paddingVertical: 10, paddingHorizontal: 14 },
  sources: { marginTop: 10, gap: 4 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  pendingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  thumbRow: { flexDirection: 'row', gap: 14, marginTop: 6 },
  choiceChip: { borderRadius: 16, borderWidth: 1.5, paddingVertical: 6, paddingHorizontal: 14 },
  actionCard: { marginTop: 10, borderWidth: 1, borderRadius: 12, padding: 10 },
  actionButtons: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  actionBtn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1 },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  quickChip: { borderRadius: 16, paddingVertical: 6, paddingHorizontal: 12 },
  inputBarShell: { marginHorizontal: 12, marginTop: 4, borderRadius: 24 },
  inputBarRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingLeft: 16, paddingRight: 6, paddingVertical: 4 },
  textInput: { flex: 1, backgroundColor: 'transparent', maxHeight: 120, fontSize: 15 },
  sendBtn: { paddingBottom: 6 },
});

export default AiChatScreen;
