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
import { resolveDisplayName } from '@/utils/identity';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import React from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
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
  const isRequest = ref.kind === 'recurringRequest';
  const isRecurring = ref.kind === 'recurringBill' || isRequest;
  // Recurring bill cards are STATEFUL without message edits (doc 26): the
  // occurrence's expense id is derivable, so the card resolves its own state
  // from live group data — upcoming → due → generated → settled.
  const recurringExpenseId =
    isRecurring && ref.occurrenceAt !== undefined ? `rec_${ref.refId}_${ref.occurrenceAt}` : undefined;
  const liveExpense =
    ref.kind === 'expense'
      ? group?.expenses.find((e) => e.expenseId === ref.refId)
      : recurringExpenseId
        ? group?.expenses.find((e) => e.expenseId === recurringExpenseId)
        : undefined;
  const recurringState: 'upcoming' | 'due' | 'generated' | 'settled' | undefined = !isRecurring
    ? undefined
    : liveExpense
      ? liveExpense.settled ? 'settled' : 'generated'
      : (ref.occurrenceAt ?? 0) > Date.now()
        ? 'upcoming'
        : 'due';
  const awaitingAmount = isRecurring && !isRequest && recurringState === 'due' && ref.snapshot.variable === true;
  const myRole = group?.members?.find((m) => m.userId === user?.userId)?.role;
  const canConfirmAmount =
    awaitingAmount && (user?.userId === ref.snapshot.payerId || myRole === 'admin' || myRole === 'owner');
  // 1:1 recurring request (doc 26): consent comes from the counterparty —
  // the person who did NOT front the bill taps accept, and the ledger books.
  const awaitingAccept = isRequest && recurringState === 'due';
  const canAccept = awaitingAccept && !!user && user.userId !== ref.snapshot.payerId && !!myRole;

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
  const liveSettlement = isSettlement ? group?.settlements.find((s) => s.settlementId === ref.refId) : undefined;
  // Doc 21's tombstone invariant: once the group's live data has actually
  // loaded, a plain expense/settlement ref whose target isn't in it anymore
  // was deleted — render a tombstone instead of the stale snapshot forever.
  // Recurring bill/request refs are excluded: for those, "no live expense
  // yet" is the normal upcoming/due state (recurringState above), not a
  // deletion signal. `!!group` gates this so offline/pre-sync (group not
  // loaded at all) still falls back to the snapshot as designed, rather than
  // being mistaken for a deletion.
  const isDeleted =
    (!isRecurring && ref.kind === 'expense' && !!group && !liveExpense) ||
    (isSettlement && !!group && !liveSettlement);
  const recurringStateLine = !isRecurring
    ? undefined
    : recurringState === 'settled'
      ? 'Settled'
      : recurringState === 'generated'
        ? `Added · paid by ${liveExpense ? resolveDisplayName(group?.members?.find((m) => m.userId === liveExpense.paidBy), ref.snapshot.payerName) : ref.snapshot.payerName}`
        : recurringState === 'due'
          ? isRequest
            ? `Awaiting accept · requested by ${ref.snapshot.payerName}`
            : awaitingAmount
              ? `Waiting for amount · ${ref.snapshot.payerName}'s turn`
              : 'Due now'
          : `${ref.snapshot.payerName}'s turn · due ${formatRelativeTime(ref.occurrenceAt ?? message.createdAt)}`;
  const subtitle = isRecurring
    ? `${ref.snapshot.recurrenceSummary ? `${ref.snapshot.recurrenceSummary} · ` : ''}${recurringStateLine}`
    : isSettlement
    ? `${ref.snapshot.payerName} → ${ref.snapshot.toName ?? 'someone'}`
    : isDigest
      ? `${ref.snapshot.participantCount} expense${ref.snapshot.participantCount === 1 ? '' : 's'}${ref.snapshot.category ? ` · Top: ${ref.snapshot.category}` : ''}`
      : isInsight
        ? ref.snapshot.category ?? 'Insight'
        : `Paid by ${ref.snapshot.payerName} · ${
            liveExpense?.participants.length ?? ref.snapshot.participantCount
          } people`;

  // Variable bill amount confirm (doc 26): payer/admin taps, enters the real
  // amount, and the expense generates through the SAME deterministic-id path
  // as auto-generation. iOS-first app — Alert.prompt is native here.
  const handleConfirmAmount = () => {
    if (!ref.occurrenceAt) return;
    lightHaptic();
    Alert.prompt(
      ref.snapshot.title,
      'Enter this occurrence’s amount to split it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Split it',
          onPress: (value?: string) => {
            const parsed = Number((value ?? '').replace(/[^0-9.]/g, ''));
            if (!Number.isFinite(parsed) || parsed <= 0) {
              Alert.alert('Invalid amount', 'Enter a positive number.');
              return;
            }
            void (async () => {
              try {
                const { getRecurringBillsForGroup, confirmVariableOccurrence } = await import(
                  '@/services/recurringBillService'
                );
                const bills = await getRecurringBillsForGroup(ref.groupId);
                const bill = bills.find((b) => b.billId === ref.refId);
                if (!bill) {
                  Alert.alert('Bill not found', 'This recurring bill no longer exists.');
                  return;
                }
                await confirmVariableOccurrence(bill, ref.occurrenceAt!, parsed);
              } catch (error) {
                console.warn('confirmVariableOccurrence failed', error);
                Alert.alert('Could not split', 'Something went wrong — try again.');
              }
            })();
          },
        },
      ],
      'plain-text',
      undefined,
      'decimal-pad',
    );
  };

  // Accept a 1:1 recurring request occurrence: books the ledger expense
  // through the SAME deterministic-id path (rec_<billId>_<occurrenceAt>), so
  // double-accepts converge on one expense.
  const handleAccept = () => {
    if (!ref.occurrenceAt) return;
    lightHaptic();
    void (async () => {
      try {
        const { getRecurringBillsForGroup, confirmVariableOccurrence } = await import(
          '@/services/recurringBillService'
        );
        const bills = await getRecurringBillsForGroup(ref.groupId);
        const bill = bills.find((b) => b.billId === ref.refId);
        if (!bill) {
          Alert.alert('Request not found', 'This recurring request no longer exists.');
          return;
        }
        await confirmVariableOccurrence(bill, ref.occurrenceAt!, bill.amount);
      } catch (error) {
        console.warn('accept recurring request failed', error);
        Alert.alert('Could not accept', 'Something went wrong — try again.');
      }
    })();
  };

  const handlePress = () => {
    const now = Date.now();
    if (onDoubleTap && now - lastTapRef.current < 280) {
      lastTapRef.current = 0;
      onDoubleTap(message);
      return;
    }
    lastTapRef.current = now;
    lightHaptic();
    if (isRecurring) {
      if (recurringState === 'generated' || recurringState === 'settled') {
        navigation.navigate(ROUTES.APP.EXPENSE_DETAILS, {
          groupId: ref.groupId,
          expenseId: recurringExpenseId,
          expenseTitle: title,
        });
      } else {
        navigation.navigate(ROUTES.APP.RECURRING_BILLS, {
          groupId: ref.groupId,
          backTitle: group?.name,
        });
      }
      return;
    }
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

  if (isDeleted) {
    return (
      <View style={[styles.wrapper, dimmed && { opacity: 0.35 }]}>
        <View
          style={[styles.card, { backgroundColor: surface, borderColor: hairline, opacity: 0.6 }]}
          accessibilityLabel={isSettlement ? 'Settlement removed' : 'Expense removed'}
        >
          <View style={[styles.iconCircle, { backgroundColor: `${theme.colors.onSurfaceVariant}22` }]}>
            <Ionicons name="trash-outline" size={18} color={theme.colors.onSurfaceVariant} />
          </View>
          <View style={styles.body}>
            <Text
              variant="bodyMedium"
              style={{ color: theme.colors.onSurfaceVariant, fontStyle: 'italic' }}
            >
              {isSettlement ? 'Settlement removed' : 'Expense removed'}
            </Text>
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, opacity: 0.7 }}>
              {formatRelativeTime(message.createdAt)}
            </Text>
          </View>
        </View>
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
  }

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
              isRecurring
                ? recurringState === 'settled'
                  ? 'checkmark-done'
                  : 'repeat'
                : isSettlement
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
          {isRecurring && liveExpense ? (
            // Settlement progress avatars (doc 26): payer implicitly ticked;
            // others tick as their share squares away (ExpenseDetails toggles).
            <View style={styles.avatarRow}>
              {liveExpense.participants.map((p) => {
                const done =
                  liveExpense.settled ||
                  p.userId === liveExpense.paidBy ||
                  (liveExpense.settledParticipantIds ?? []).includes(p.userId);
                const successColor = theme.colors.success ?? theme.colors.primary;
                const name = resolveDisplayName(
                  group?.members?.find((m) => m.userId === p.userId),
                  '?',
                );
                return (
                  <View
                    key={p.userId}
                    style={[
                      styles.avatarChip,
                      {
                        borderColor: done ? successColor : hairline,
                        backgroundColor: done ? `${successColor}22` : 'transparent',
                      },
                    ]}
                    accessibilityLabel={`${name} ${done ? 'settled' : 'not settled'}`}
                  >
                    <Text
                      style={{
                        fontSize: 10,
                        fontWeight: '700',
                        color: done ? successColor : theme.colors.onSurfaceVariant,
                      }}
                    >
                      {name.slice(0, 1).toUpperCase()}
                    </Text>
                    {done ? <Ionicons name="checkmark" size={9} color={successColor} /> : null}
                  </View>
                );
              })}
            </View>
          ) : null}
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, opacity: 0.7 }}>
            {formatRelativeTime(message.createdAt)}
          </Text>
        </View>
        <View style={styles.amountWrap}>
          {awaitingAmount && !liveExpense ? (
            <Text variant="titleSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              —
            </Text>
          ) : (
            <MoneyText
              amount={amount}
              currency={currency}
              groupId={ref.groupId}
              tone={isSettlement || recurringState === 'settled' ? 'positive' : 'plain'}
              size="subtitle"
            />
          )}
          <Ionicons name="chevron-forward" size={14} color={theme.colors.onSurfaceVariant} />
        </View>
      </Pressable>
      {canAccept ? (
        <Pressable
          onPress={handleAccept}
          accessibilityRole="button"
          accessibilityLabel={`Accept recurring request ${title}`}
          style={({ pressed }) => [
            styles.confirmButton,
            { backgroundColor: `${theme.colors.primary}1A`, borderColor: hairline },
            pressed && { opacity: 0.7 },
          ]}
        >
          <Ionicons name="checkmark-circle-outline" size={14} color={theme.colors.primary} />
          <Text variant="labelMedium" style={{ color: theme.colors.primary, fontWeight: '600' }}>
            Accept & add
          </Text>
        </Pressable>
      ) : null}
      {canConfirmAmount ? (
        <Pressable
          onPress={handleConfirmAmount}
          accessibilityRole="button"
          accessibilityLabel={`Enter amount for ${title}`}
          style={({ pressed }) => [
            styles.confirmButton,
            { backgroundColor: `${theme.colors.primary}1A`, borderColor: hairline },
            pressed && { opacity: 0.7 },
          ]}
        >
          <Ionicons name="create-outline" size={14} color={theme.colors.primary} />
          <Text variant="labelMedium" style={{ color: theme.colors.primary, fontWeight: '600' }}>
            Enter amount & split
          </Text>
        </Pressable>
      ) : null}
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
  avatarRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 3,
    marginBottom: 1,
  },
  avatarChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 9,
    borderWidth: 1,
  },
  confirmButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
