/**
 * InsightChatOverlay — the narrative card, expanded into a full-screen chat
 * (doc 23). GLASS-FIRST per DESIGN.md: LiquidBackground canvas, GlassView
 * bubbles/chrome, transform-only motion (opacity/layout animations above
 * native glass kill the material). Swipe-down on the grabber/header dismisses
 * (1:1 finger tracking, rubber-banded upward, fling or distance commits).
 *
 * Transparency DNA: every assistant message carries an engine badge
 * (On-device / Private Cloud / Exact) and the header shows the LIVE engine
 * chip for the latest reply. Context chips disclose fresh-facts injection.
 */

import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { GuardedScreen } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import type { Group } from '@/models';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { thumbsDown, thumbsUp } from '@/services/aiFeedbackService';
import { prewarmOnDeviceModel } from '../../../modules/splitcircle-ai';
import { FEEDBACK_REASON_LABELS, type FeedbackReason } from '@/utils/aiFeedback';
import { deleteThread, listThreads, newMessageId, saveThread } from '@/services/aiThreadStore';
import { getLastPccQuota, type PccQuotaInfo } from '@/services/insightsAiService';
import {
  actionPayloadOf,
  getEnginePref,
  INSIGHTS_SURFACE,
  openInsightsThread,
  resolveInsightsAction,
  sendInsightsMessage,
  setEnginePref,
  type EnginePref,
} from '@/services/insightsChatService';
import { RANGE_LABELS, type StatsRange } from '@/utils/statsInsights';
import type { AiThread, AiThreadMessage } from '@/utils/aiThreads';
import { formatCurrency } from '@/utils/currency';
import { lightHaptic, mediumHaptic } from '@/utils/haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  TextInput as RNTextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { ActivityIndicator, Icon, Text } from 'react-native-paper';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface InsightChatOverlayProps {
  visible: boolean;
  onClose: () => void;
  scope: string;
  facts: string;
  narrative: string;
  /** Which engine wrote the narrative — badges the seed message correctly. */
  narrativeSource?: 'ondevice' | 'pcc';
  seedTitle: string;
  /** Real-data starter questions shown on a fresh thread. */
  starterPrompts: string[];
  /** Heuristic insight cards — the deterministic "something new" inventory. */
  cards?: { title: string; body: string }[];
  /** Facts for an arbitrary range — powers the in-chat context picker. */
  factsForRange?: (range: StatsRange) => string;
  /** The stats screen's current range (context picker default). */
  initialRange?: StatsRange;
  /** Present for group scope — enables the deterministic exact-answer path. */
  group?: Group;
  currentUserId?: string;
  /** Personal scope: cross-group rows for the agentic personal tools (doc 24). */
  personalGroups?: { groupId: string; name: string; currency: string; expenses?: Group['expenses'] }[];
}

const ENGINE_OPTIONS: { key: EnginePref; icon: string; label: string; hint: string }[] = [
  { key: 'auto', icon: 'auto-fix', label: 'Auto', hint: 'On-device first, Private Cloud for big asks' },
  { key: 'ondevice', icon: 'chip', label: 'On-device', hint: 'Never leaves this phone' },
  { key: 'pcc', icon: 'cloud-lock-outline', label: 'Private Cloud', hint: "Apple's private servers, when available" },
];

const SOURCE_BADGE: Record<string, { icon: string; label: string }> = {
  ondevice: { icon: 'chip', label: 'On-device' },
  pcc: { icon: 'cloud-lock-outline', label: 'Private Cloud' },
  deterministic: { icon: 'calculator-variant-outline', label: 'Exact' },
};

export const InsightChatOverlay = ({
  visible,
  onClose,
  scope,
  facts,
  narrative,
  narrativeSource,
  seedTitle,
  starterPrompts,
  cards,
  factsForRange,
  initialRange,
  group,
  currentUserId,
  personalGroups,
}: InsightChatOverlayProps) => {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  // Doc 24 P4: confirm-card writes execute through the SAME GroupContext
  // mutators the assistant uses — the model never mutates anything.
  const { addExpense, settleUp, updateExpense, deleteExpense, deleteSettlement, updateGroupBudgets } =
    useGroups();
  // P5: the group's chat id unlocks the on-device-only chat_search tool.
  const { threads: chatThreads } = useChat();
  const groupChatId = useMemo(
    () => (group ? chatThreads.find((t) => t.groupId === group.groupId)?.chatId : undefined),
    [chatThreads, group],
  );
  const { height: screenHeight, width: screenWidth } = useWindowDimensions();
  const listRef = useRef<FlatList<AiThreadMessage>>(null);

  const [thread, setThread] = useState<AiThread | null>(null);
  const [history, setHistory] = useState<AiThread[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [drifted, setDrifted] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // P2 live turn feedback: the loop's status line, then streamed narration.
  const [pending, setPending] = useState<{ status?: string; partial?: string } | null>(null);
  // Doc 25 flywheel: per-message thumb state ('ask' = reason chips showing).
  const [feedback, setFeedback] = useState<Record<string, 'up' | 'ask' | 'down'>>({});
  const [keyboardShown, setKeyboardShown] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // P3: structured PCC quota from the latest call — the menu's truth line.
  const [pccQuota, setPccQuota] = useState<PccQuotaInfo | null>(null);
  useEffect(() => {
    if (settingsOpen) setPccQuota(getLastPccQuota());
  }, [settingsOpen]);
  const [engine, setEngine] = useState<EnginePref>('auto');
  const [contextRange, setContextRange] = useState<StatsRange>(initialRange ?? 'month');

  useEffect(() => {
    void getEnginePref().then(setEngine);
  }, []);

  // Doc 25: warm the model when the overlay opens — first turn skips cold-load.
  useEffect(() => {
    if (visible) prewarmOnDeviceModel();
  }, [visible]);

  // The facts actually grounding this chat: the user-picked context range.
  const activeFacts = factsForRange ? factsForRange(contextRange) : facts;

  // Composer hugs the keyboard: the safe-area bottom margin only applies when
  // the keyboard is down — otherwise it floats a dead gap above the keys.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s = Keyboard.addListener(showEvt, () => setKeyboardShown(true));
    const h = Keyboard.addListener(hideEvt, () => setKeyboardShown(false));
    return () => {
      s.remove();
      h.remove();
    };
  }, []);

  // ── Motion: entrance morph + swipe-down dismissal (transform-only —
  // Reanimated transforms are safe above native glass; opacity is not).
  // Same RNGH Pan + Modal pattern as FilterSortSheet.
  const entrance = useSharedValue(0);
  const drag = useSharedValue(0);
  const dragX = useSharedValue(0);

  useEffect(() => {
    if (!visible) return;
    entrance.value = 0;
    drag.value = 0;
    dragX.value = 0;
    entrance.value = withTiming(1, { duration: 300, easing: Easing.out(Easing.cubic) });
  }, [visible, entrance, drag, dragX]);

  const finishClose = useCallback(() => {
    onClose();
    drag.value = 0;
    dragX.value = 0;
  }, [onClose, drag, dragX]);

  // Plain function ref — module objects (Keyboard) can't cross into worklets.
  const hideKeyboard = useCallback(() => {
    Keyboard.dismiss();
  }, []);

  const dismiss = useCallback(() => {
    Keyboard.dismiss();
    drag.value = withTiming(
      screenHeight,
      { duration: 230, easing: Easing.in(Easing.cubic) },
      () => {
        runOnJS(finishClose)();
      },
    );
  }, [drag, screenHeight, finishClose]);

  // Grabber/header drag: tracks the finger 1:1 downward, rubber-clamped
  // upward; a committed fling or distance dismisses. activeOffsetY keeps
  // plain taps flowing to the header buttons.
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(10)
        .onStart(() => {
          runOnJS(hideKeyboard)();
        })
        .onUpdate((e) => {
          drag.value = Math.max(0, e.translationY);
        })
        .onEnd((e) => {
          if (e.translationY > 130 || e.velocityY > 900) {
            drag.value = withTiming(screenHeight, { duration: 220 }, () => {
              runOnJS(finishClose)();
            });
          } else {
            drag.value = withSpring(0, { damping: 50 });
          }
        }),
    [drag, finishClose, hideKeyboard, screenHeight],
  );

  // Left-edge swipe-back (iOS back gesture semantics): the sheet tracks the
  // finger to the right and a committed swipe dismisses.
  const backGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(12)
        .failOffsetY([-16, 16])
        .onStart(() => {
          runOnJS(hideKeyboard)();
        })
        .onUpdate((e) => {
          dragX.value = Math.max(0, e.translationX);
        })
        .onEnd((e) => {
          if (e.translationX > 90 || e.velocityX > 800) {
            dragX.value = withTiming(screenWidth, { duration: 200 }, () => {
              runOnJS(finishClose)();
            });
          } else {
            dragX.value = withSpring(0, { damping: 50 });
          }
        }),
    [dragX, finishClose, hideKeyboard, screenWidth],
  );

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: (1 - entrance.value) * 24 + drag.value },
      { translateX: dragX.value },
      { scale: 0.94 + entrance.value * 0.06 },
    ],
  }));

  // Auto-follow guard: follow streaming growth ONLY while the user is already
  // pinned near the bottom. The old unconditional onContentSizeChange →
  // scrollToEnd re-fired on every streamed token, compounding offsets past the
  // content (the "infinite scroll into the void") and yanking any attempt to
  // scroll back. Scrolling up now disengages following; an explicit send
  // re-engages it.
  const nearBottom = useRef(true);

  const scrollToEnd = useCallback(() => {
    nearBottom.current = true;
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const openThread = useCallback(
    async (forceNew: boolean) => {
      const result = await openInsightsThread({
        scope,
        facts: activeFacts,
        narrative,
        seedTitle,
        seedSource: narrativeSource,
        forceNew,
      });
      setThread(result.thread);
      setDrifted(result.driftDetected);
      setHistoryOpen(false);
      scrollToEnd();
    },
    [scope, activeFacts, narrative, narrativeSource, seedTitle, scrollToEnd],
  );

  // Open ONCE per overlay-open: openThread's identity changes with the
  // context range (activeFacts), and re-running it mid-conversation would
  // churn threads under the user.
  const openedRef = useRef(false);
  useEffect(() => {
    if (visible && !openedRef.current) {
      openedRef.current = true;
      void openThread(false);
    }
    if (!visible) openedRef.current = false;
  }, [visible, openThread]);

  const refreshHistory = useCallback(async () => {
    setHistory(await listThreads(INSIGHTS_SURFACE, scope));
  }, [scope]);

  const toggleHistory = () => {
    lightHaptic();
    if (!historyOpen) void refreshHistory();
    setSettingsOpen(false);
    setHistoryOpen((v) => !v);
  };

  const toggleSettings = () => {
    lightHaptic();
    setHistoryOpen(false);
    setSettingsOpen((v) => !v);
  };

  const changeEngine = (pref: EnginePref) => {
    lightHaptic();
    setEngine(pref);
    void setEnginePref(pref);
  };

  // Context switches are DISCLOSED in-thread (transparency DNA) and persisted.
  const changeContext = (r: StatsRange) => {
    if (r === contextRange) return;
    lightHaptic();
    setContextRange(r);
    if (thread) {
      const chip: AiThreadMessage = {
        id: `ctx-${Date.now()}`,
        role: 'context',
        text: `Context: ${RANGE_LABELS[r]}`,
        createdAt: Date.now(),
      };
      const next = { ...thread, messages: [...thread.messages, chip] };
      setThread(next);
      void saveThread(next);
      scrollToEnd();
    }
  };

  const switchThread = (t: AiThread) => {
    lightHaptic();
    setThread(t);
    setDrifted(false);
    setHistoryOpen(false);
    scrollToEnd();
  };

  const removeThread = async (t: AiThread) => {
    lightHaptic();
    await deleteThread(INSIGHTS_SURFACE, scope, t.threadId);
    await refreshHistory();
    if (thread?.threadId === t.threadId) await openThread(false);
  };

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || busy || !thread) return;
    mediumHaptic();
    setInput('');
    setBusy(true);
    // Optimistic user bubble; the service returns the authoritative thread.
    const optimistic: AiThreadMessage = {
      id: `optimistic-${Date.now()}`,
      role: 'user',
      text,
      createdAt: Date.now(),
    };
    setThread((t) => (t ? { ...t, messages: [...t.messages, optimistic] } : t));
    setPending({ status: 'Thinking…' });
    scrollToEnd();
    try {
      const result = await sendInsightsMessage({
        thread,
        userText: text,
        facts: activeFacts,
        cards,
        group,
        currentUserId,
        personalGroups,
        chatId: groupChatId,
        drifted,
        engine,
        onStatus: (line) => setPending((p) => ({ ...p, status: line })),
        onDelta: (partial) => setPending({ partial }),
      });
      setThread(result.thread);
      setDrifted(false);
    } catch {
      setThread((t) =>
        t
          ? {
              ...t,
              messages: [
                ...t.messages,
                {
                  id: `err-${Date.now()}`,
                  role: 'assistant',
                  text: "I couldn't reach the on-device model just now — try again in a moment.",
                  createdAt: Date.now(),
                },
              ],
            }
          : t,
      );
    } finally {
      setBusy(false);
      setPending(null);
      scrollToEnd();
    }
  };

  // Confirm/cancel a proposed write (doc 24 P4). Execution happens HERE, via
  // GroupContext, before the card flips to done — mirroring AiChatScreen.
  const resolveAction = async (msg: AiThreadMessage, confirm: boolean) => {
    if (!thread || busy) return;
    const p = actionPayloadOf(msg.payload);
    if (!p || p.state !== 'pending') return;
    lightHaptic();
    if (!confirm) {
      setThread(await resolveInsightsAction({ thread, messageId: msg.id, outcome: 'cancelled' }));
      return;
    }
    if (!group) return;
    setBusy(true);
    try {
      const a = p.action;
      let ok = '✓ Done.';
      if (a.type === 'add_expense') {
        await addExpense(group.groupId, a.expense, undefined, undefined, newMessageId());
        ok = '✓ Expense added.';
      } else if (a.type === 'settle_up') {
        await settleUp(group.groupId, a.settlement, newMessageId());
        ok = '✓ Settlement recorded.';
      } else if (a.type === 'edit_expense') {
        await updateExpense(group.groupId, a.expense, undefined, undefined, newMessageId());
        ok = '✓ Expense updated.';
      } else if (a.type === 'delete_expense') {
        await deleteExpense(group.groupId, a.expenseId);
        ok = '✓ Expense deleted.';
      } else if (a.type === 'delete_settlement') {
        await deleteSettlement(group.groupId, a.settlementId);
        ok = '✓ Settlement deleted.';
      } else if (a.type === 'set_budget') {
        const next = { ...(group.budgets ?? {}) };
        if (a.amount > 0) next[a.category] = a.amount;
        else delete next[a.category];
        await updateGroupBudgets(group.groupId, next);
        ok = a.amount > 0 ? '✓ Budget set.' : '✓ Budget removed.';
      }
      mediumHaptic();
      setThread(
        await resolveInsightsAction({ thread, messageId: msg.id, outcome: 'done', confirmationText: ok }),
      );
    } catch (err) {
      // Keep the card pending; surface the failure as a thread message.
      const errMsg: AiThreadMessage = {
        id: newMessageId(),
        role: 'assistant',
        text: `Couldn't complete that: ${err instanceof Error ? err.message : 'unknown error'}.`,
        createdAt: Date.now(),
      };
      const next = { ...thread, messages: [...thread.messages, errMsg] };
      setThread(next);
      void saveThread(next);
    } finally {
      setBusy(false);
      scrollToEnd();
    }
  };

  // Doc 25: 👍 records sentiment; 👎 opens reason chips, then snapshots the
  // whole turn into a local eval fixture (reduced when the trace ring is gone).
  const onThumb = (msg: AiThreadMessage, up: boolean) => {
    lightHaptic();
    if (up) {
      setFeedback((s) => ({ ...s, [msg.id]: 'up' }));
      void thumbsUp(msg.id);
    } else {
      setFeedback((s) => ({ ...s, [msg.id]: 'ask' }));
    }
  };

  const onFeedbackReason = (msg: AiThreadMessage, reason?: FeedbackReason) => {
    lightHaptic();
    setFeedback((s) => ({ ...s, [msg.id]: 'down' }));
    const idx = thread?.messages.findIndex((m) => m.id === msg.id) ?? -1;
    const prevUser = idx > 0 ? [...(thread?.messages.slice(0, idx) ?? [])].reverse().find((m) => m.role === 'user') : undefined;
    void thumbsDown(msg.id, reason, {
      surface: INSIGHTS_SURFACE,
      scope,
      userText: prevUser?.text ?? '',
      replyText: msg.text,
    });
  };

  const hairline = isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)';

  const showStarters = (thread?.messages.filter((m) => m.role === 'user').length ?? 0) === 0;

  // Live engine chip: the engine behind the LATEST assistant reply.
  const liveEngine = useMemo(() => {
    const last = [...(thread?.messages ?? [])]
      .reverse()
      .find((m) => m.role === 'assistant' && m.source);
    return SOURCE_BADGE[last?.source ?? 'ondevice'];
  }, [thread]);

  const renderItem = ({ item }: { item: AiThreadMessage }) => {
    if (item.role === 'context') {
      return (
        <View style={styles.contextRow}>
          <View style={[styles.contextChip, { backgroundColor: theme.colors.pressed }]}>
            <Icon source="refresh" size={12} color={theme.colors.onSurfaceVariant} />
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {item.text}
            </Text>
          </View>
        </View>
      );
    }
    // Doc 24 ask-backs: a clarify bubble with tappable option chips. Chips are
    // live only while this is the latest message — answered clarifies keep the
    // question text but drop the buttons.
    if (item.role === 'clarify') {
      const isLatest = thread?.messages[thread.messages.length - 1]?.id === item.id;
      return (
        <View style={[styles.msgRow, { justifyContent: 'flex-start' }]}>
          <GlassView style={[styles.bubble, { borderTopLeftRadius: 4 }]}>
            <Text style={{ color: theme.colors.onSurface, lineHeight: 20 }}>{item.text}</Text>
            {isLatest && (item.options?.length ?? 0) > 0 && (
              <View style={styles.clarifyRow}>
                {item.options?.map((opt) => (
                  <TouchableOpacity
                    key={opt}
                    onPress={() => void send(opt)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={opt}
                  >
                    <GlassView style={[styles.starterChip, { borderColor: `${theme.colors.primary}70` }]}>
                      <Text variant="labelSmall" style={{ color: theme.colors.primary, fontWeight: '600' }}>
                        {opt}
                      </Text>
                    </GlassView>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </GlassView>
        </View>
      );
    }
    const isUser = item.role === 'user';
    const badge = item.source ? SOURCE_BADGE[item.source] : null;
    const isLatestMsg = thread?.messages[thread.messages.length - 1]?.id === item.id;
    const actionPayload = isUser ? null : actionPayloadOf(item.payload);
    return (
      <View style={[styles.msgRow, { justifyContent: isUser ? 'flex-end' : 'flex-start' }]}>
        <GlassView
          style={[
            styles.bubble,
            isUser
              ? { backgroundColor: theme.colors.primary, borderTopRightRadius: 4 }
              : { borderTopLeftRadius: 4 },
          ]}
        >
          <Text style={{ color: isUser ? '#fff' : theme.colors.onSurface, lineHeight: 20 }}>
            {item.text}
          </Text>
          {!isUser && !!item.assumption && (
            <Text
              variant="labelSmall"
              style={{ color: theme.colors.onSurfaceVariant, fontSize: 10, marginTop: 4, fontStyle: 'italic' }}
            >
              {item.assumption}
            </Text>
          )}
          {/* Confirm card for a proposed write (doc 24 P4). */}
          {actionPayload && (
            <View style={[styles.actionCard, { borderColor: `${theme.colors.primary}50` }]}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                {actionPayload.action.summary}
              </Text>
              {actionPayload.state === 'pending' ? (
                <View style={styles.actionButtons}>
                  <TouchableOpacity
                    onPress={() => void resolveAction(item, false)}
                    disabled={busy}
                    style={[styles.actionBtn, { borderColor: theme.colors.outline }]}
                    accessibilityRole="button"
                    accessibilityLabel="Not now"
                  >
                    <Text style={{ color: theme.colors.onSurfaceVariant, fontWeight: '700' }}>Not now</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => void resolveAction(item, true)}
                    disabled={busy}
                    style={[
                      styles.actionBtn,
                      { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Confirm"
                  >
                    <Text style={{ color: '#fff', fontWeight: '700' }}>Confirm</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                  {actionPayload.state === 'done' ? '✓ Done' : 'Dismissed'}
                </Text>
              )}
            </View>
          )}
          {/* Assistant quick-reply chips (slot-filling asks, doc 24 P4). */}
          {!isUser && isLatestMsg && (item.options?.length ?? 0) > 0 && (
            <View style={styles.clarifyRow}>
              {item.options?.map((opt) => (
                <TouchableOpacity
                  key={opt}
                  onPress={() => void send(opt)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={opt}
                >
                  <GlassView style={[styles.starterChip, { borderColor: `${theme.colors.primary}70` }]}>
                    <Text variant="labelSmall" style={{ color: theme.colors.primary, fontWeight: '600' }}>
                      {opt}
                    </Text>
                  </GlassView>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {item.sources && item.sources.length > 0 && (
            <View style={styles.sources}>
              {item.sources.map((s, i) => (
                <View key={`${s.expenseId ?? s.title}-${i}`} style={styles.sourceRow}>
                  <Text variant="bodySmall" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                    [{i + 1}]
                  </Text>
                  <Text
                    variant="bodySmall"
                    style={{ flex: 1, color: theme.colors.onSurface }}
                    numberOfLines={1}
                  >
                    {s.title ?? 'Expense'}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    {formatCurrency(s.amount, s.currency ?? group?.currency ?? 'USD')}
                  </Text>
                </View>
              ))}
            </View>
          )}
          {!isUser && badge && (
            <View style={styles.badgeRow}>
              <Icon source={badge.icon} size={11} color={theme.colors.onSurfaceVariant} />
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, fontSize: 10 }}>
                {badge.label}
              </Text>
            </View>
          )}
          {/* Doc 25 flywheel: thumbs → reason chips → local eval fixture. */}
          {!isUser &&
            (feedback[item.id] === 'ask' ? (
              <View style={styles.clarifyRow}>
                {(Object.keys(FEEDBACK_REASON_LABELS) as FeedbackReason[]).map((r) => (
                  <TouchableOpacity
                    key={r}
                    onPress={() => onFeedbackReason(item, r)}
                    accessibilityRole="button"
                    accessibilityLabel={FEEDBACK_REASON_LABELS[r]}
                  >
                    <GlassView style={[styles.starterChip, { borderColor: `${theme.colors.primary}70` }]}>
                      <Text variant="labelSmall" style={{ color: theme.colors.primary, fontWeight: '600' }}>
                        {FEEDBACK_REASON_LABELS[r]}
                      </Text>
                    </GlassView>
                  </TouchableOpacity>
                ))}
              </View>
            ) : feedback[item.id] === 'down' ? (
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, fontSize: 10, marginTop: 4 }}>
                Noted — added to AI evals
              </Text>
            ) : (
              <View style={styles.thumbRow}>
                <TouchableOpacity
                  onPress={() => onThumb(item, true)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Good answer"
                >
                  <Icon
                    source={feedback[item.id] === 'up' ? 'thumb-up' : 'thumb-up-outline'}
                    size={13}
                    color={feedback[item.id] === 'up' ? theme.colors.primary : theme.colors.onSurfaceVariant}
                  />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => onThumb(item, false)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Bad answer"
                >
                  <Icon source="thumb-down-outline" size={13} color={theme.colors.onSurfaceVariant} />
                </TouchableOpacity>
              </View>
            ))}
        </GlassView>
      </View>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={dismiss}>
      <View style={[styles.scrim, { backgroundColor: 'rgba(0,0,0,0.45)' }]}>
        <Animated.View style={[styles.sheet, sheetStyle]}>
          <LiquidBackground style={styles.flex}>
            <GuardedScreen target="expenses" label="Insights hidden">
              <KeyboardAvoidingView
                style={styles.flex}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              >
                {/* Left-edge swipe-back strip (iOS back-gesture semantics). */}
                <GestureDetector gesture={backGesture}>
                  <View style={styles.edgeStrip} />
                </GestureDetector>

                {/* Grabber + header — absolute glass over the list, which
                    scrolls edge-to-edge beneath it. Also the swipe-down zone. */}
                <GestureDetector gesture={panGesture}>
                <View style={[styles.headerWrap, { paddingTop: insets.top + 2 }]}>
                  <View style={styles.grabberZone}>
                    <View style={[styles.grabber, { backgroundColor: theme.colors.pressed }]} />
                  </View>
                  <View style={styles.header}>
                    <TouchableOpacity
                      onPress={() => {
                        lightHaptic();
                        dismiss();
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Close insights chat"
                    >
                      <GlassView style={styles.glassCircle}>
                        <Icon source="chevron-down" size={24} color={theme.colors.onSurface} />
                      </GlassView>
                    </TouchableOpacity>
                    <View style={styles.headerTitle}>
                      {/* Floating headers are glass pills (DESIGN.md); tapping
                          this one opens the model + context picker menu. */}
                      <TouchableOpacity
                        onPress={toggleSettings}
                        accessibilityRole="button"
                        accessibilityLabel="Model and context settings"
                      >
                        <GlassView style={styles.titlePill} contentStyle={styles.titlePillContent}>
                          <Text
                            variant="titleSmall"
                            numberOfLines={1}
                            style={{ color: theme.colors.onSurface, fontWeight: '700' }}
                          >
                            {thread?.title ?? 'Insights'}
                          </Text>
                          <View style={styles.engineChip}>
                            <Icon source={liveEngine.icon} size={11} color={theme.colors.primary} />
                            <Text
                              variant="labelSmall"
                              style={{ color: theme.colors.onSurfaceVariant, fontSize: 10 }}
                            >
                              {liveEngine.label} · {RANGE_LABELS[contextRange]}
                            </Text>
                            <Icon
                              source={settingsOpen ? 'chevron-up' : 'chevron-down'}
                              size={12}
                              color={theme.colors.onSurfaceVariant}
                            />
                          </View>
                        </GlassView>
                      </TouchableOpacity>
                    </View>
                    <TouchableOpacity
                      onPress={toggleHistory}
                      accessibilityRole="button"
                      accessibilityLabel="Conversation history"
                    >
                      <GlassView style={styles.glassCircle}>
                        <Icon
                          source="history"
                          size={20}
                          color={historyOpen ? theme.colors.primary : theme.colors.onSurface}
                        />
                      </GlassView>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        lightHaptic();
                        void openThread(true);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="New thread"
                    >
                      <GlassView style={styles.glassCircle}>
                        <Icon source="plus" size={22} color={theme.colors.onSurface} />
                      </GlassView>
                    </TouchableOpacity>
                  </View>
                </View>
                </GestureDetector>

                {/* Model + context picker — the title pill's liquid-glass menu */}
                {settingsOpen && (
                  <GlassView style={[styles.historyPanel, { top: insets.top + 66 }]}>
                    <Text
                      variant="labelSmall"
                      style={[styles.menuSection, { color: theme.colors.onSurfaceVariant }]}
                    >
                      MODEL
                    </Text>
                    {ENGINE_OPTIONS.map((o) => (
                      <TouchableOpacity
                        key={o.key}
                        style={styles.menuRow}
                        onPress={() => changeEngine(o.key)}
                        accessibilityRole="button"
                        accessibilityLabel={`Use ${o.label}`}
                      >
                        <Icon
                          source={o.icon}
                          size={18}
                          color={engine === o.key ? theme.colors.primary : theme.colors.onSurfaceVariant}
                        />
                        <View style={styles.menuRowBody}>
                          <Text
                            variant="labelMedium"
                            style={{
                              color: engine === o.key ? theme.colors.primary : theme.colors.onSurface,
                              fontWeight: '600',
                            }}
                          >
                            {o.label}
                          </Text>
                          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                            {o.key === 'pcc' && pccQuota?.limitReached
                              ? `Daily quota reached${
                                  pccQuota.resetDate
                                    ? ` · resets ${new Date(pccQuota.resetDate).toLocaleString('en-US', { month: 'short', day: 'numeric' })}`
                                    : ''
                                }`
                              : o.hint}
                          </Text>
                        </View>
                        {engine === o.key && (
                          <Icon source="check" size={16} color={theme.colors.primary} />
                        )}
                      </TouchableOpacity>
                    ))}
                    {factsForRange && (
                      <>
                        <Text
                          variant="labelSmall"
                          style={[styles.menuSection, { color: theme.colors.onSurfaceVariant }]}
                        >
                          CONTEXT
                        </Text>
                        {(Object.keys(RANGE_LABELS) as StatsRange[]).map((r) => (
                          <TouchableOpacity
                            key={r}
                            style={styles.menuRow}
                            onPress={() => changeContext(r)}
                            accessibilityRole="button"
                            accessibilityLabel={`Ground the chat in ${RANGE_LABELS[r]}`}
                          >
                            <Icon
                              source="calendar-range"
                              size={18}
                              color={
                                contextRange === r ? theme.colors.primary : theme.colors.onSurfaceVariant
                              }
                            />
                            <View style={styles.menuRowBody}>
                              <Text
                                variant="labelMedium"
                                style={{
                                  color:
                                    contextRange === r ? theme.colors.primary : theme.colors.onSurface,
                                  fontWeight: '600',
                                }}
                              >
                                {RANGE_LABELS[r]}
                              </Text>
                            </View>
                            {contextRange === r && (
                              <Icon source="check" size={16} color={theme.colors.primary} />
                            )}
                          </TouchableOpacity>
                        ))}
                      </>
                    )}
                  </GlassView>
                )}

                {/* History dropdown */}
                {historyOpen && (
                  <GlassView style={[styles.historyPanel, { top: insets.top + 66 }]}>
                    {history.length === 0 ? (
                      <Text
                        variant="labelSmall"
                        style={{ color: theme.colors.onSurfaceVariant, padding: 14 }}
                      >
                        No conversations yet.
                      </Text>
                    ) : (
                      history.map((t, i) => (
                        <View
                          key={t.threadId}
                          style={[
                            styles.historyRow,
                            i < history.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: hairline },
                          ]}
                        >
                          <TouchableOpacity
                            style={styles.historyMain}
                            onPress={() => switchThread(t)}
                            accessibilityRole="button"
                            accessibilityLabel={`Open ${t.title}`}
                          >
                            <Text
                              variant="labelMedium"
                              numberOfLines={1}
                              style={{
                                color:
                                  t.threadId === thread?.threadId
                                    ? theme.colors.primary
                                    : theme.colors.onSurface,
                                fontWeight: '600',
                              }}
                            >
                              {t.title}
                            </Text>
                            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                              {new Date(t.updatedAt).toLocaleDateString()}
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => void removeThread(t)}
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

                {/* Messages */}
                <FlatList
                  ref={listRef}
                  data={thread?.messages ?? []}
                  keyExtractor={(m) => m.id}
                  renderItem={renderItem}
                  // Absolute fill: content runs to the SCREEN bottom, gliding
                  // behind the glass composer; padding keeps the last bubble
                  // readable above it. Keyboard insets handled natively.
                  style={StyleSheet.absoluteFill}
                  automaticallyAdjustKeyboardInsets
                  contentContainerStyle={[
                    styles.list,
                    { paddingTop: insets.top + 88, paddingBottom: 92 + insets.bottom },
                  ]}
                  keyboardShouldPersistTaps="handled"
                  onScroll={(e) => {
                    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                    nearBottom.current =
                      contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
                  }}
                  scrollEventThrottle={64}
                  onContentSizeChange={() => {
                    if (nearBottom.current) listRef.current?.scrollToEnd({ animated: false });
                  }}
                  ListFooterComponent={
                    busy ? (
                      <View style={[styles.msgRow, { justifyContent: 'flex-start' }]}>
                        <GlassView style={[styles.bubble, { borderTopLeftRadius: 4 }]}>
                          {pending?.partial ? (
                            // Streamed narration filling in live (P2).
                            <Text style={{ color: theme.colors.onSurface, lineHeight: 20 }}>
                              {pending.partial}
                            </Text>
                          ) : (
                            <View style={styles.pendingRow}>
                              <ActivityIndicator size="small" color={theme.colors.primary} />
                              {!!pending?.status && (
                                <Text
                                  variant="labelSmall"
                                  style={{ color: theme.colors.onSurfaceVariant }}
                                >
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

                {/* Spacer pins the starters+composer to the bottom while the
                    absolute list scrolls behind them; touches pass through. */}
                <View style={styles.flex} pointerEvents="none" />

                {/* Starter chips — real-data questions, fresh threads only */}
                {showStarters && starterPrompts.length > 0 && (
                  <View style={styles.starterRow}>
                    {starterPrompts.map((p) => (
                      <TouchableOpacity
                        key={p}
                        onPress={() => void send(p)}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={p}
                      >
                        <GlassView style={[styles.starterChip, { borderColor: `${theme.colors.primary}70` }]}>
                          <Text
                            variant="labelSmall"
                            style={{ color: theme.colors.primary, fontWeight: '600' }}
                          >
                            {p}
                          </Text>
                        </GlassView>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {/* Composer — layout lives in contentStyle: GlassCard lays out
                    children in its INNER content view, not the outer shell. */}
                <GlassView
                  style={[
                    styles.inputBarShell,
                    { marginBottom: keyboardShown ? 6 : Math.max(insets.bottom, 10) },
                  ]}
                  contentStyle={styles.inputBarRow}
                >
                  {/* Plain RN TextInput: Paper's flat input renders no visible
                      caret over glass; explicit colors guarantee caret + text. */}
                  <RNTextInput
                    value={input}
                    onChangeText={setInput}
                    placeholder="Ask about these stats…"
                    placeholderTextColor={theme.colors.onSurfaceVariant}
                    multiline
                    style={[styles.textInput, { color: theme.colors.onSurface }]}
                    selectionColor={theme.colors.primary}
                    cursorColor={theme.colors.primary}
                    onSubmitEditing={() => void send()}
                    blurOnSubmit
                  />
                  <TouchableOpacity
                    onPress={() => void send()}
                    disabled={busy || !input.trim()}
                    style={styles.sendBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Send"
                  >
                    <Icon
                      source="arrow-up-circle"
                      size={32}
                      color={input.trim() && !busy ? theme.colors.primary : theme.colors.onSurfaceVariant}
                    />
                  </TouchableOpacity>
                </GlassView>
              </KeyboardAvoidingView>
            </GuardedScreen>
          </LiquidBackground>
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scrim: { flex: 1 },
  sheet: { flex: 1, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden' },
  headerWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 5,
  },
  edgeStrip: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 28,
    zIndex: 6,
  },
  grabberZone: {
    alignSelf: 'stretch',
    alignItems: 'center',
    paddingVertical: 8,
  },
  grabber: {
    width: 44,
    height: 5,
    borderRadius: 3,
  },
  titlePill: {
    borderRadius: 18,
  },
  titlePillContent: {
    alignItems: 'center',
    gap: 1,
    paddingHorizontal: 16,
    paddingVertical: 5,
  },
  menuSection: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 4,
    fontSize: 10,
    letterSpacing: 1,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  menuRowBody: {
    flex: 1,
    minWidth: 0,
    gap: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  glassCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { flex: 1, minWidth: 0, alignItems: 'center', gap: 1 },
  engineChip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  historyPanel: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 10,
    borderRadius: 18,
    overflow: 'hidden',
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  historyMain: { flex: 1, minWidth: 0, paddingVertical: 11, paddingHorizontal: 14, gap: 1 },
  historyDelete: { padding: 12 },
  list: { padding: 12, gap: 10, paddingBottom: 8 },
  msgRow: { flexDirection: 'row', width: '100%' },
  bubble: { maxWidth: '88%', borderRadius: 18, paddingVertical: 10, paddingHorizontal: 14 },
  contextRow: { alignItems: 'center' },
  contextChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 12,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  sources: { marginTop: 8, gap: 4 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  starterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  clarifyRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  pendingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  thumbRow: { flexDirection: 'row', gap: 14, marginTop: 6 },
  actionCard: { borderWidth: 1, borderRadius: 12, padding: 10, marginTop: 10, gap: 6 },
  actionButtons: { flexDirection: 'row', gap: 8, marginTop: 4 },
  actionBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    alignItems: 'center',
  },
  starterChip: {
    borderRadius: 16,
    borderWidth: 1.5,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  inputBarShell: {
    marginHorizontal: 12,
    marginTop: 4,
    borderRadius: 24,
  },
  inputBarRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 2,
  },
  textInput: {
    flex: 1,
    backgroundColor: 'transparent',
    maxHeight: 120,
    fontSize: 15,
    paddingTop: 12,
    paddingBottom: 12,
  },
  sendBtn: { paddingBottom: 8 },
});
