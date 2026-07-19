// Money-in-chat expense/settlement card (ai_layer/docs/21). Renders a muted,
// system-adjacent card in the chat feed for auto-posted money events. The
// message's expenseRef is a POINTER + render snapshot: the card prefers the
// live expense from GroupContext (so "your share" and edits stay current) and
// falls back to the snapshot while offline / before sync. Tap-through opens
// the canonical details screen — the card itself carries no actions besides
// reactions (locked decision: tap-through + reactions only).
//
// Money renders go through MoneyText with groupId, so the privacy guard and
// the display-currency lens both apply — chat never leaks what the expenses
// tab hides.

import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import { MoneyText } from '@/components/ui/MoneyText';
import { ReactionsRow } from '@/components/Chat/ReactionsRow';
import type { ChatMessage } from '@/models';
import { formatRelativeTime } from '@/utils/format';
import { lightHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

interface ExpenseCardBubbleProps {
  message: ChatMessage;
  dimmed?: boolean;
  onLongPress?: (message: ChatMessage) => void;
  onDoubleTap?: (message: ChatMessage) => void;
  onReactionsPress?: (message: ChatMessage) => void;
}

export const ExpenseCardBubble = ({
  message,
  dimmed,
  onLongPress,
  onDoubleTap,
  onReactionsPress,
}: ExpenseCardBubbleProps) => {
  const { theme, isDark } = useTheme();
  const { user } = useAuth();
  const { groups } = useGroups();
  const navigation = useNavigation<any>();
  const lastTapRef = React.useRef(0);

  const ref = message.expenseRef;
  if (!ref) return null;

  const group = groups.find((g) => g.groupId === ref.groupId);
  const liveExpense =
    ref.kind === 'expense'
      ? group?.expenses.find((e) => e.expenseId === ref.refId)
      : undefined;

  // Live data wins; snapshot keeps the card renderable offline/pre-sync.
  const title = liveExpense?.title ?? ref.snapshot.title;
  const amount = liveExpense?.amount ?? ref.snapshot.amount;
  const currency = group?.currency ?? ref.snapshot.currency;
  const myShare =
    user && liveExpense
      ? liveExpense.participants.find((p) => p.userId === user.userId)?.share
      : undefined;

  const isSettlement = ref.kind === 'settlement';
  const isDigest = ref.kind === 'digest';
  const isInsight = ref.kind === 'insight';
  const subtitle = isSettlement
    ? `${ref.snapshot.payerName} → ${ref.snapshot.toName ?? 'someone'}`
    : isDigest
      ? `${ref.snapshot.participantCount} expense${ref.snapshot.participantCount === 1 ? '' : 's'}${ref.snapshot.category ? ` · Top: ${ref.snapshot.category}` : ''}`
      : isInsight
        ? ref.snapshot.category ?? 'Insight'
        : `Paid by ${ref.snapshot.payerName} · ${
            liveExpense?.participants.length ?? ref.snapshot.participantCount
          } people`;

  const handlePress = () => {
    const now = Date.now();
    if (onDoubleTap && now - lastTapRef.current < 280) {
      lastTapRef.current = 0;
      onDoubleTap(message);
      return;
    }
    lastTapRef.current = now;
    lightHaptic();
    if (isSettlement) {
      navigation.navigate(ROUTES.APP.SETTLEMENTS, { groupId: ref.groupId, settlementId: ref.refId });
    } else if (isDigest || isInsight) {
      // Deep-link into the insights chat thread (doc 23) — the stats screen
      // opens the overlay once the narrative is ready.
      navigation.navigate(ROUTES.APP.GROUP_STATS, { groupId: ref.groupId, openInsightsChat: true });
    } else {
      navigation.navigate(ROUTES.APP.EXPENSE_DETAILS, {
        groupId: ref.groupId,
        expenseId: ref.refId,
        expenseTitle: title,
      });
    }
  };

  const surface = isDark ? 'rgba(28, 31, 38, 0.85)' : 'rgba(255, 255, 255, 0.9)';
  const hairline = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.08)';
  const iconBg = isSettlement
    ? `${theme.colors.success ?? theme.colors.primary}22`
    : `${theme.colors.primary}22`;
  const iconColor = isSettlement ? (theme.colors.success ?? theme.colors.primary) : theme.colors.primary;

  return (
    <View style={[styles.wrapper, dimmed && { opacity: 0.35 }]}>
      <Pressable
        onPress={handlePress}
        onLongPress={onLongPress ? () => onLongPress(message) : undefined}
        delayLongPress={280}
        accessibilityRole="button"
        accessibilityLabel={
          isSettlement ? `Settlement: ${subtitle}` : `Expense ${title}, ${subtitle}`
        }
        style={({ pressed }) => [
          styles.card,
          { backgroundColor: surface, borderColor: hairline },
          pressed && { opacity: 0.85 },
        ]}
      >
        <View style={[styles.iconCircle, { backgroundColor: iconBg }]}>
          <Ionicons
            name={
              isSettlement
                ? 'checkmark-done'
                : isDigest
                  ? 'stats-chart'
                  : isInsight
                    ? 'pulse'
                    : 'receipt-outline'
            }
            size={18}
            color={iconColor}
          />
        </View>
        <View style={styles.body}>
          <Text
            variant="bodyMedium"
            numberOfLines={1}
            style={{ color: theme.colors.onSurface, fontWeight: '600' }}
          >
            {isSettlement ? 'Settled up' : title}
          </Text>
          <Text variant="labelSmall" numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant }}>
            {subtitle}
            {myShare !== undefined && myShare > 0 && !isSettlement ? ' · your share ' : ''}
            {myShare !== undefined && myShare > 0 && !isSettlement ? (
              <MoneyText amount={myShare} currency={currency} groupId={ref.groupId} tone="plain" size="body" />
            ) : null}
          </Text>
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, opacity: 0.7 }}>
            {formatRelativeTime(message.createdAt)}
          </Text>
        </View>
        <View style={styles.amountWrap}>
          <MoneyText
            amount={amount}
            currency={currency}
            groupId={ref.groupId}
            tone={isSettlement ? 'positive' : 'plain'}
            size="subtitle"
          />
          <Ionicons name="chevron-forward" size={14} color={theme.colors.onSurfaceVariant} />
        </View>
      </Pressable>
      <View style={styles.reactionsWrap}>
        <ReactionsRow
          reactions={message.reactions}
          currentUserId={user?.userId}
          align="left"
          onPress={onReactionsPress ? () => onReactionsPress(message) : undefined}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    marginVertical: 6,
    width: '100%',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    maxWidth: '88%',
    minWidth: '70%',
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  iconCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  amountWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  reactionsWrap: {
    maxWidth: '88%',
  },
});
