import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { EmptyState, GlassCard, GuardedScreen } from '@/components/ui';
import { PrimaryButton } from '@/components/PrimaryButton';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import { getExpenseDetailsTitle } from '@/navigation/screenTitles';
import { LoadingScreen } from '@/screens/onboarding/LoadingScreen';
import { radius, spacing } from '@/theme';
import { useMoneyDisplay } from '@/hooks/useMoneyDisplay';
import { getExpenseSplitDetails } from '@/utils/expenseSplit';
import { buildReceiptInsightRows } from '@/utils/receiptInsights';
import { useNavigation } from '@react-navigation/native';
import * as Linking from 'expo-linking';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, Image, Modal, Pressable, StyleSheet, TouchableOpacity, View } from 'react-native';
import { appAlert } from '@/utils/appAlert';
import { Button, Chip, Divider, Icon, IconButton, Text, TextInput } from 'react-native-paper';

// Category to Icon mapping
const getCategoryIcon = (category: string): string => {
  const iconMap: Record<string, string> = {
    'General': 'tag',
    'Food': 'food',
    'Transport': 'car',
    'Utilities': 'flash',
    'Entertainment': 'movie',
    'Shopping': 'cart',
    'Travel': 'airplane',
    'Health': 'medical-bag',
  };
  return iconMap[category] || 'tag';
};

interface ExpenseDetailsScreenProps {
  route: any;
  navigation: any;
}

export const ExpenseDetailsScreen = ({ route }: ExpenseDetailsScreenProps) => {
  const navigation = useNavigation<any>();
  const { groupId, expenseId } = route.params;
  const { groups, deleteExpense, updateExpense } = useGroups();
  const { user } = useAuth();
  const { theme, isDark } = useTheme();
  const scrollY = useRef(new Animated.Value(0)).current;
  const group = groups.find((g) => g.groupId === groupId);
  const expense = group?.expenses.find((e) => e.expenseId === expenseId);
  const fmtMoney = useMoneyDisplay(groupId);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: getExpenseDetailsTitle(expense?.title),
      headerTitle: '',
      headerTransparent: true,
      headerTintColor: theme.colors.primary,
    });
  }, [navigation, theme.colors.primary, expense?.title]);

  useLayoutEffect(() => {
    const grp = groups.find((g) => g.groupId === groupId);
    if (grp) {
      navigation.setOptions({ headerBackTitle: grp.name });
    }
  }, [navigation, groups, groupId]);

  // Transform slide-in, not opacity — fractional alpha on an ancestor kills
  // UIVisualEffectView glass materials (see StickyHeaderPill).
  const headerTranslate = scrollY.interpolate({
    inputRange: [0, 60],
    outputRange: [-160, 0],
    extrapolate: 'clamp',
  });

  const [note, setNote] = useState(expense?.notes || '');
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showImageModal, setShowImageModal] = useState(false);
  const [showMoreInfo, setShowMoreInfo] = useState(false);

  const memberMap = useMemo(
    () =>
      group
        ? Object.fromEntries(
            [...(group.members ?? []), ...(group.archivedMembers ?? [])].map((m) => [
              m.userId,
              m.displayName,
            ]),
          )
        : {},
    [group],
  );

  // Hoisted above the early return below: when a deep link renders the
  // "waiting for sync" fallback first and the group then syncs in, this same
  // component instance re-renders with MORE hooks if any hook lives past the
  // early return — React crashes with "Rendered more hooks than during the
  // previous render". Keep every hook above the fallback branch.
  const splitDetails = useMemo(
    () => (group && expense ? getExpenseSplitDetails(expense, memberMap, group.currency, fmtMoney) : null),
    [expense, group?.currency, memberMap, fmtMoney],
  );

  if (!group || !expense) {
    // Deep links (expense notifications) can land here before Firestore
    // syncs, or after the group/expense was deleted. Wait briefly for sync,
    // then time out into a "not found" state with a way back. If the group
    // is already synced but the expense is missing, it was deleted — show
    // the empty state immediately.
    const handleBack = () => {
      if (typeof navigation.canGoBack === 'function' && navigation.canGoBack()) {
        navigation.goBack();
        return;
      }
      navigation.navigate(ROUTES.APP.ROOT, { screen: ROUTES.APP.GROUPS_TAB });
    };

    if (group) {
      return (
        <LiquidBackground>
          <View style={styles.center}>
            <EmptyState
              icon="receipt-text-outline"
              title="Expense not found"
              hint="This expense may have been deleted."
              actionLabel="Go back"
              onAction={handleBack}
            />
          </View>
        </LiquidBackground>
      );
    }

    return (
      <LoadingScreen
        timeoutMs={10000}
        timeoutIcon="receipt-text-outline"
        timeoutTitle="Expense not found"
        timeoutHint="This expense may have been deleted or isn't available on this device."
        timeoutActionLabel="Go back"
        onTimeoutAction={handleBack}
      />
    );
  }

  const handleDelete = async () => {
    try {
      await deleteExpense(groupId, expenseId);
      navigation.goBack();
    } catch (error) {
      appAlert('Error', 'Failed to delete expense');
    }
  };

  const handleSaveNote = async (requestId: string) => {
    try {
      await updateExpense(groupId, { ...expense, notes: note }, undefined, undefined, requestId);
      setIsEditingNote(false);
    } catch (error) {
      appAlert('Error', 'Failed to save note');
    }
  };

  const handleEditExpense = () => {
    navigation.navigate(ROUTES.APP.ADD_EXPENSE, { groupId, expenseId });
  };

  const payerName = memberMap[expense.paidBy] || 'Unknown';

  return (
    <LiquidBackground>
      <GuardedScreen target="expenses" entityId={groupId} label="Expense hidden">
      <Animated.View style={[styles.stickyHeader, { transform: [{ translateY: headerTranslate }] }]}>
        <GlassView style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={[styles.stickyHeaderTitle, { color: theme.colors.onSurface }]} numberOfLines={1}>
            {expense.title}
          </Text>
        </GlassView>
      </Animated.View>

      <Animated.ScrollView
        contentContainerStyle={styles.container}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true }
        )}
        scrollEventThrottle={16}
      >
        <View style={{ height: 60 }} />
        <GlassView style={styles.card}>
          <View style={styles.header}>
            <View>
              <Text variant="headlineMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>{expense.title}</Text>
              <Text variant="titleMedium" style={[styles.amount, { color: theme.colors.onSurface }]}>
                {fmtMoney(expense.amount, group.currency)}
              </Text>
            </View>
            <Chip icon={getCategoryIcon(expense.category)} style={{ backgroundColor: theme.colors.secondaryContainer }} textStyle={{ color: theme.colors.onSecondaryContainer }}>{expense.category}</Chip>
          </View>

          <Text style={[styles.meta, { color: theme.colors.onSurfaceVariant }]}>
            Paid by {payerName} on {new Date(expense.createdAt).toLocaleDateString()}
          </Text>

          {expense.recurring && (
            <View style={[styles.recurringBanner, { backgroundColor: isDark ? 'rgba(100,180,255,0.12)' : 'rgba(33,150,243,0.08)' }]}>
              <IconButton icon="autorenew" size={18} iconColor={theme.colors.primary} style={{ margin: 0 }} />
              <Text style={{ color: theme.colors.onSurfaceVariant, flex: 1, fontSize: 13 }}>
                This is a recurring expense. Editing it only changes this occurrence — future recurrences are unaffected.
              </Text>
            </View>
          )}

          {expense.receipt?.url && (
            <View style={styles.section}>
              <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>Receipt</Text>
              {expense.receipt.fileName?.toLowerCase().endsWith('.pdf') ||
                expense.receipt.fileName?.toLowerCase().endsWith('.doc') ||
                expense.receipt.fileName?.toLowerCase().endsWith('.docx') ? (
                <TouchableOpacity
                  style={[styles.documentContainer, { backgroundColor: theme.colors.surfaceVariant }]}
                  onPress={() => Linking.openURL(expense.receipt!.url!)}
                >
                  <IconButton icon="file-document" size={40} iconColor={theme.colors.primary} />
                  <Text variant="bodyLarge" style={{ flex: 1, color: theme.colors.onSurface }}>
                    {expense.receipt.fileName || 'Document'}
                  </Text>
                  <IconButton icon="open-in-new" size={20} iconColor={theme.colors.onSurfaceVariant} />
                </TouchableOpacity>
              ) : (
                <TouchableOpacity onPress={() => setShowImageModal(true)}>
                  <Image source={{ uri: expense.receipt.url }} style={[styles.receiptThumbnail, { backgroundColor: theme.colors.surfaceVariant }]} resizeMode="cover" />
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Receipt Items Section (from itemized split / scan) */}
          {expense.splitMetadata?.method === 'itemized' && expense.splitMetadata.receiptItems && expense.splitMetadata.receiptItems.length > 0 && (
            <>
              <Divider style={[styles.divider, { backgroundColor: theme.colors.pressed }]} />
              <View style={styles.section}>
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Scanned Items
                </Text>
                {expense.splitMetadata.receiptItems.map((item, index) => (
                  <View key={item.id || index} style={styles.receiptItemRow}>
                    <View style={{ flex: 1 }}>
                      <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                        {item.name}
                      </Text>
                      {item.assignedTo && item.assignedTo.length > 0 && (
                        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                          {item.assignedTo.map((uid) => memberMap[uid] || 'Unknown').join(', ')}
                        </Text>
                      )}
                    </View>
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                      {fmtMoney(item.price, group.currency)}
                    </Text>
                  </View>
                ))}

                {(expense.splitMetadata.taxAmount != null && expense.splitMetadata.taxAmount > 0) && (
                  <View style={styles.receiptItemRow}>
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>Tax</Text>
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                      {fmtMoney(expense.splitMetadata.taxAmount, group.currency)}
                    </Text>
                  </View>
                )}

                {(expense.splitMetadata.tipAmount != null && expense.splitMetadata.tipAmount > 0) && (
                  <View style={styles.receiptItemRow}>
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>Tip</Text>
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                      {fmtMoney(expense.splitMetadata.tipAmount, group.currency)}
                    </Text>
                  </View>
                )}
              </View>
            </>
          )}

          {/* More info — rich on-device receipt insights (address, payment, savings…) */}
          {(() => {
            const insightRows = buildReceiptInsightRows(
              expense.receipt?.insights,
              (n) => fmtMoney(n, group.currency),
            );
            if (insightRows.length === 0) return null;
            return (
              <>
                <Divider style={[styles.divider, { backgroundColor: theme.colors.pressed }]} />
                <View style={styles.section}>
                  <TouchableOpacity
                    onPress={() => setShowMoreInfo((v) => !v)}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={showMoreInfo ? 'Hide more info' : 'Show more info'}
                    style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
                  >
                    <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface, marginBottom: 0 }]}>
                      More info
                    </Text>
                    <Icon source={showMoreInfo ? 'chevron-up' : 'chevron-down'} size={22} color={theme.colors.onSurfaceVariant} />
                  </TouchableOpacity>
                  {showMoreInfo && (
                    <View style={{ marginTop: 8 }}>
                      {insightRows.map((row) => (
                        <View key={row.label} style={styles.receiptItemRow}>
                          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>{row.label}</Text>
                          <Text
                            variant="bodyMedium"
                            style={{ color: theme.colors.onSurface, fontWeight: '600', flexShrink: 1, textAlign: 'right', marginLeft: 16 }}
                          >
                            {row.value}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              </>
            );
          })()}

          <Divider style={[styles.divider, { backgroundColor: theme.colors.pressed }]} />

          <View style={styles.section}>
            <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
              Paid by
            </Text>
            <View style={styles.row}>
              <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>{payerName}</Text>
              <Text variant="bodyLarge" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
                {fmtMoney(expense.amount, group.currency)}
              </Text>
            </View>
          </View>

          <Divider style={[styles.divider, { backgroundColor: theme.colors.pressed }]} />

          {splitDetails ? (
            <View style={styles.section}>
              <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                Split mode
              </Text>
              <View style={styles.splitModeHeader}>
                <Chip
                  icon="tune-variant"
                  style={{ backgroundColor: theme.colors.secondaryContainer }}
                  textStyle={{ color: theme.colors.onSecondaryContainer }}
                >
                  {splitDetails.label}
                </Chip>
              </View>
              <Text variant="bodySmall" style={[styles.splitModeNote, { color: theme.colors.onSurfaceVariant }]}>
                {splitDetails.note}
              </Text>
              {splitDetails.rows.map((row) => (
                <View key={`${row.label}-${row.value}`} style={styles.row}>
                  <Text variant="bodyMedium" style={[styles.detailLabel, { color: theme.colors.onSurfaceVariant }]}>
                    {row.label}
                  </Text>
                  <Text variant="bodyMedium" style={[styles.detailValue, { color: theme.colors.onSurface }]}>
                    {row.value}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          <Divider style={[styles.divider, { backgroundColor: theme.colors.pressed }]} />

          <View style={styles.section}>
            <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
              Split with
            </Text>
            <Text variant="bodySmall" style={[styles.splitModeNote, { color: theme.colors.onSurfaceVariant }]}>
              A personal reminder only — it doesn't record a payment or change the group balance. Use Settle Up for that.
            </Text>
            {expense.participants.map((p) => {
              // Per-participant settle ticks (doc 26): purely a presentational
              // "did they pay me back informally" marker — payer is implicitly
              // settled; payer/admins can tick anyone, members can tick
              // themselves. All non-payer ticked → expense.settled. This is
              // NEVER read by balance/debt computation (adaptGroup) by design
              // — a real payment must go through Settle Up, which is the
              // actual source of truth. See ai_layer/docs/26 §"Per-participant
              // settle state".
              const isPayer = p.userId === expense.paidBy;
              const ticked = isPayer || (expense.settledParticipantIds ?? []).includes(p.userId);
              const myRole = group.members.find((m) => m.userId === user?.userId)?.role;
              const canToggle =
                !isPayer &&
                !!user &&
                (user.userId === expense.paidBy ||
                  user.userId === p.userId ||
                  myRole === 'admin' ||
                  myRole === 'owner');
              const toggle = async () => {
                const next = new Set(expense.settledParticipantIds ?? []);
                if (next.has(p.userId)) next.delete(p.userId);
                else next.add(p.userId);
                const allSettled = expense.participants
                  .filter((part) => part.userId !== expense.paidBy)
                  .every((part) => next.has(part.userId));
                try {
                  await updateExpense(groupId, {
                    ...expense,
                    settledParticipantIds: [...next],
                    settled: allSettled,
                  });
                } catch (error) {
                  console.warn('toggle participant settled failed', error);
                }
              };
              return (
                <View key={p.userId} style={styles.row}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                    <IconButton
                      icon={ticked ? 'check-circle' : 'circle-outline'}
                      size={20}
                      iconColor={ticked ? (theme.colors.success ?? theme.colors.primary) : theme.colors.onSurfaceVariant}
                      disabled={!canToggle}
                      onPress={canToggle ? () => { void toggle(); } : undefined}
                      style={{ margin: 0 }}
                      accessibilityLabel={`${memberMap[p.userId] || 'Unknown'} ${ticked ? 'settled' : 'not settled'}`}
                    />
                    <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>
                      {memberMap[p.userId] || 'Unknown'}
                      {isPayer ? ' (paid)' : ''}
                    </Text>
                  </View>
                  <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>{fmtMoney(p.share, group.currency)}</Text>
                </View>
              );
            })}
          </View>

          <Divider style={[styles.divider, { backgroundColor: theme.colors.pressed }]} />

          <View style={styles.section}>
            <View style={styles.row}>
              <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                Notes & Comments
              </Text>
              {!isEditingNote && (
                <IconButton icon="pencil" size={20} onPress={() => setIsEditingNote(true)} iconColor={theme.colors.primary} />
              )}
            </View>
            {isEditingNote ? (
              <View>
                <TextInput
                  mode="outlined"
                  value={note}
                  onChangeText={setNote}
                  placeholder="Add a note..."
                  multiline
                  numberOfLines={3}
                  style={{ marginBottom: 8, backgroundColor: isDark ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.5)' }}
                  outlineColor={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)'}
                  textColor={theme.colors.onSurface}
                  placeholderTextColor={theme.colors.onSurfaceVariant}
                  theme={{ colors: { background: 'transparent' } }}
                />
                <View style={styles.noteActions}>
                  <Button onPress={() => setIsEditingNote(false)}>Cancel</Button>
                  <PrimaryButton
                    onPress={handleSaveNote}
                    requestKey={`expense-note-${expenseId}`}
                    loadingMessage="Saving note..."
                    showGlobalOverlay
                  >
                    Save
                  </PrimaryButton>
                </View>
              </View>
            ) : (
              <Text variant="bodyMedium" style={{ color: note ? theme.colors.onSurface : theme.colors.onSurfaceVariant }}>
                {note || 'No notes added.'}
              </Text>
            )}
          </View>

          <View style={styles.actions}>
            <Button mode="outlined" icon="pencil" onPress={handleEditExpense} style={{ flex: 1 }}>
              Edit Expense
            </Button>
            <Button
              mode="outlined"
              icon="delete"
              textColor={theme.colors.error}
              style={{ flex: 1, borderColor: theme.colors.error }}
              onPress={() => setShowDeleteDialog(true)}
            >
              Delete
            </Button>
          </View>
        </GlassView>

        <Modal
          visible={showDeleteDialog}
          transparent
          statusBarTranslucent
          animationType="fade"
          onRequestClose={() => setShowDeleteDialog(false)}
        >
          <Pressable
            style={styles.deleteDialogBackdrop}
            onPress={() => setShowDeleteDialog(false)}
            accessibilityLabel="Dismiss delete confirmation"
          />
          <View style={styles.deleteDialogWrap} pointerEvents="box-none">
            <GlassCard style={styles.deleteDialogCard}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                Delete Expense
              </Text>
              <Text variant="bodyMedium" style={[styles.deleteDialogBody, { color: theme.colors.onSurfaceVariant }]}>
                Are you sure you want to delete this expense? This cannot be undone.
              </Text>
              <View style={styles.deleteDialogActions}>
                <Button onPress={() => setShowDeleteDialog(false)}>Cancel</Button>
                <Button textColor={theme.colors.error} onPress={handleDelete}>
                  Delete
                </Button>
              </View>
            </GlassCard>
          </View>
        </Modal>

        <Modal visible={showImageModal} transparent={true} onRequestClose={() => setShowImageModal(false)}>
          <View style={styles.modalContainer}>
            <TouchableOpacity style={styles.modalCloseButton} onPress={() => setShowImageModal(false)}>
              <Text style={{ color: 'white', fontSize: 18 }}>Close</Text>
            </TouchableOpacity>
            {expense.receipt?.url && (
              <Image source={{ uri: expense.receipt.url }} style={styles.fullImage} resizeMode="contain" />
            )}
          </View>
        </Modal>
      </Animated.ScrollView>
    </GuardedScreen>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: spacing.md,
    paddingBottom: 180,
    flexGrow: 1,
  },
  deleteDialogBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  deleteDialogWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  deleteDialogCard: {
    width: '100%',
    maxWidth: 400,
    padding: spacing.lg,
  },
  deleteDialogBody: {
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  deleteDialogActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.xs,
  },
  card: {
    padding: spacing.lg,
    borderRadius: radius.xl,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.sm,
  },
  amount: {
    fontWeight: 'bold',
    fontSize: 24,
    marginTop: spacing.xs,
  },
  meta: {
    marginBottom: spacing.md,
  },
  recurringBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: 10,
    marginBottom: spacing.md,
    gap: spacing.xs,
  },
  divider: {
    marginVertical: spacing.md,
  },
  section: {
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    marginBottom: 12,
    fontWeight: '600',
  },
  splitModeHeader: {
    marginBottom: 10,
  },
  splitModeNote: {
    marginBottom: 12,
    lineHeight: 18,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
    alignItems: 'center',
    gap: spacing.md,
  },
  detailLabel: {
    flex: 1,
  },
  detailValue: {
    flex: 1,
    textAlign: 'right',
  },
  noteActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  actions: {
    marginTop: spacing.xl,
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
  receiptThumbnail: {
    width: '100%',
    height: 200,
    borderRadius: radius.xs,
  },
  documentContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.xs,
    padding: spacing.sm,
  },
  receiptItemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    gap: spacing.md,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCloseButton: {
    position: 'absolute',
    top: 40,
    right: 20,
    zIndex: 1,
    padding: 10,
  },
  fullImage: {
    width: '100%',
    height: '80%',
  },
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingTop: 50,
    paddingHorizontal: spacing.md,
    paddingBottom: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stickyHeaderGlass: {
    paddingVertical: spacing.sm,
    paddingHorizontal: 20,
    borderRadius: radius.lg,
    maxWidth: '80%',
  },
  stickyHeaderTitle: {
    fontWeight: 'bold',
  },
});
