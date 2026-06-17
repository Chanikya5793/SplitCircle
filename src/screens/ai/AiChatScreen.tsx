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
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { Group } from '@/models';
import type { ExpenseAiSource } from '@/services/aiService';
import { processAssistantTurn, type ConversationState, type ProposedAction } from '@/services/assistantService';
import { clearChatSession, loadChatSession, saveChatSession } from '@/services/chatSession';
import type { NavTarget } from '@/utils/assistantChat';
import { formatCurrency } from '@/utils/currency';
import { lightHaptic, mediumHaptic, successHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useHeaderHeight } from '@react-navigation/elements';
import { useCallback, useEffect, useRef, useState } from 'react';
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

// A proposed-action card older than this (parsed from its id timestamp) is
// retired on restore; anything more recent stays live so a reload mid-flow keeps it.
const STALE_CARD_MS = 30 * 60 * 1000;
const tsOf = (id: string): number => {
  const m = /^(\d+)/.exec(id);
  return m ? Number(m[1]) : 0;
};

export const AiChatScreen = ({ group, initialQuestion }: AiChatScreenProps) => {
  const { theme, isDark } = useTheme();
  const { user } = useAuth();
  const { addExpense, settleUp, deleteExpense, updateExpense, deleteSettlement } = useGroups();
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

  const append = useCallback(
    (msg: ChatMsg) => {
      setMessages((prev) => {
        const next = [...prev, msg];
        persist(next);
        return next;
      });
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    },
    [persist],
  );

  // Restore the persisted conversation for this group on first mount.
  useEffect(() => {
    let active = true;
    void loadChatSession<ChatMsg>(group.groupId).then((saved) => {
      if (!active || hydrated.current) return;
      hydrated.current = true;
      if (saved && saved.messages.length > 0) {
        // Retire only STALE confirm cards (older than the window); a recent
        // proposal is kept live so reloading mid-flow doesn't kill it. An
        // in-progress slot-filling draft (`pending`) is always preserved so a
        // reload continues the flow instead of forgetting it (screenshot bug #6).
        const now = Date.now();
        let keptLiveCard = false;
        const restored = saved.messages.map((m) => {
          if (m.action && m.actionState === 'pending') {
            if (now - tsOf(m.id) > STALE_CARD_MS) return { ...m, actionState: 'cancelled' as ActionState };
            keptLiveCard = true;
          }
          return m;
        });
        setMessages(restored);
        stateRef.current = {
          pending: saved.state?.pending,
          lastProposed: keptLiveCard ? saved.state?.lastProposed : undefined,
        };
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
        const turn = await processAssistantTurn(text, group, currentUserId, stateRef.current);
        stateRef.current = turn.state;
        append({
          id: uid(),
          role: 'assistant',
          text: turn.reply,
          sources: turn.sources,
          action: turn.action,
          actionState: turn.action ? 'pending' : undefined,
          choices: turn.choices,
        });
      } catch (err) {
        append({ id: uid(), role: 'assistant', text: err instanceof Error ? err.message : 'Something went wrong. Try again.' });
      } finally {
        setBusy(false);
      }
    },
    [append, busy, currentUserId, group, input],
  );

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

  // Wipe the conversation: clear persisted session + reset to a fresh greeting.
  const clearConversation = useCallback(() => {
    void clearChatSession(group.groupId);
    stateRef.current = {};
    successHaptic();
    setMessages([GREETING(group.name)]);
  }, [group.groupId, group.name]);

  const confirmAction = async (msg: ChatMsg) => {
    const a = msg.action;
    if (!a || a.type === 'navigate' || busy) return;
    if (a.type === 'clear_chat') {
      clearConversation();
      return;
    }
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

  const renderItem = ({ item }: { item: ChatMsg }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[styles.row, { justifyContent: isUser ? 'flex-end' : 'flex-start' }]}>
        <GlassView
          style={[
            styles.bubble,
            isUser
              ? { backgroundColor: theme.colors.primary, borderTopRightRadius: 4 }
              : { borderTopLeftRadius: 4 },
          ]}
        >
          <Text style={{ color: isUser ? '#fff' : theme.colors.onSurface, lineHeight: 20 }}>{item.text}</Text>

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

          {item.action && item.actionState === 'pending' ? (
            item.action.type === 'navigate' ? (
              <View style={[styles.actionCard, { borderColor: theme.colors.outline }]}>
                <View style={styles.actionButtons}>
                  <TouchableOpacity onPress={() => setActionState(item.id, 'cancelled')} style={[styles.actionBtn, { borderColor: theme.colors.outline }]}>
                    <Text style={{ color: theme.colors.onSurfaceVariant, fontWeight: '700' }}>Not now</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => openTarget(item, (item.action as { target: NavTarget }).target)} style={[styles.actionBtn, { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary }]}>
                    <Text style={{ color: '#fff', fontWeight: '700' }}>Open {item.action.summary}</Text>
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
                    <Text style={{ color: '#fff', fontWeight: '700' }}>{item.action.type === 'clear_chat' ? 'Clear' : 'destructive' in item.action && item.action.destructive ? 'Delete' : 'Confirm'}</Text>
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
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={headerHeight}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={renderItem}
          contentContainerStyle={[styles.list, { paddingTop: headerHeight + 8 }]}
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={
            busy ? (
              <View style={[styles.row, { justifyContent: 'flex-start' }]}>
                <GlassView style={[styles.bubble, { borderTopLeftRadius: 4 }]}>
                  <ActivityIndicator color={theme.colors.primary} />
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

        <View style={[styles.inputBar, { marginBottom: Math.max(insets.bottom, 8), backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}>
          <TextInput
            mode="flat"
            value={input}
            onChangeText={setInput}
            placeholder="Ask, add an expense, or settle up…  (tap the keyboard mic to speak)"
            multiline
            underlineColor="transparent"
            activeUnderlineColor="transparent"
            style={styles.textInput}
            onSubmitEditing={() => send()}
            blurOnSubmit
          />
          <TouchableOpacity onPress={() => send()} disabled={busy || !input.trim()} style={styles.sendBtn} accessibilityLabel="Send">
            <Icon source="arrow-up-circle" size={34} color={input.trim() && !busy ? theme.colors.primary : theme.colors.onSurfaceVariant} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { padding: 12, gap: 10, paddingBottom: 8 },
  row: { flexDirection: 'row', width: '100%' },
  bubble: { maxWidth: '88%', borderRadius: 18, paddingVertical: 10, paddingHorizontal: 14 },
  sources: { marginTop: 10, gap: 4 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  choiceChip: { borderRadius: 16, borderWidth: 1.5, paddingVertical: 6, paddingHorizontal: 14 },
  actionCard: { marginTop: 10, borderWidth: 1, borderRadius: 12, padding: 10 },
  actionButtons: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  actionBtn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1 },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  quickChip: { borderRadius: 16, paddingVertical: 6, paddingHorizontal: 12 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginHorizontal: 12, marginTop: 4, borderRadius: 24, paddingLeft: 16, paddingRight: 6, paddingVertical: 4 },
  textInput: { flex: 1, backgroundColor: 'transparent', maxHeight: 120, fontSize: 15 },
  sendBtn: { paddingBottom: 6 },
});

export default AiChatScreen;
