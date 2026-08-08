import { FONT_CAP } from '@/utils/a11yText';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { GuardedScreen } from '@/components/ui';
import { PrimaryButton } from '@/components/PrimaryButton';
import { useAppLock } from '@/context/AppLockContext';
import { useDisplayCurrency } from '@/context/DisplayCurrencyContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import { formatCurrency } from '@/utils/currency';
import { authenticate, isBiometricAvailable } from '@/services/biometrics';
import { resolveDisplayName, resolveInitials } from '@/utils/identity';
import type { Group, GroupMember } from '@/models';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Avatar, Button, IconButton, Text, TextInput, TouchableRipple } from 'react-native-paper';

interface SettlementsScreenProps {
  group: Group;
  onClose: () => void;
  settlementId?: string;
  initialFromUserId?: string;
  initialToUserId?: string;
  initialAmount?: number;
}

export const SettlementsScreen = ({
  group,
  onClose,
  settlementId,
  initialFromUserId,
  initialToUserId,
  initialAmount
}: SettlementsScreenProps) => {
  const { settleUp, updateSettlement } = useGroups();
  const { settings: appLock } = useAppLock();
  const { getConversion } = useDisplayCurrency();
  const { theme, isDark } = useTheme();

  // Display-currency lens: settlements are ALWAYS recorded in the group
  // currency; when the lens is on we show the converted equivalent as a
  // reference line under the amount so the user can sanity-check it.
  const displayConversion = getConversion(group.groupId, group.currency);

  // Find existing settlement if editing
  const existingSettlement = settlementId
    ? group.settlements.find(s => s.settlementId === settlementId)
    : undefined;

  const [fromUserId, setFromUserId] = useState(
    existingSettlement?.fromUserId ?? initialFromUserId ?? group.members[0]?.userId ?? ''
  );
  const [toUserId, setToUserId] = useState(
    existingSettlement?.toUserId ?? initialToUserId ?? group.members[1]?.userId ?? ''
  );
  const [amount, setAmount] = useState(
    existingSettlement?.amount.toString() ?? (initialAmount ? initialAmount.toString() : '')
  );
  const [note, setNote] = useState(existingSettlement?.note ?? '');

  const [showMemberSelector, setShowMemberSelector] = useState(false);
  const [selectionMode, setSelectionMode] = useState<'from' | 'to'>('from');

  const isEditMode = !!settlementId && !!existingSettlement;

  const handleSettle = async (requestId: string) => {
    // Optional Face ID confirmation before money moves. Gated behind the
    // per-device setting AND available biometrics — on web (no module) the
    // check is skipped so settlements still work. Device fallback allowed so
    // the user can never be permanently blocked from settling.
    if (appLock.confirmSettlements && (await isBiometricAvailable())) {
      const ok = await authenticate('Confirm settlement', true);
      if (!ok) return;
    }
    if (isEditMode && existingSettlement) {
      // Update existing settlement
      await updateSettlement(group.groupId, {
        ...existingSettlement,
        fromUserId,
        toUserId,
        amount: Number(amount),
        note,
      }, requestId);
    } else {
      // Create new settlement
      await settleUp(group.groupId, {
        fromUserId,
        toUserId,
        amount: Number(amount),
        note,
      }, requestId);
    }
    onClose();
  };

  const openSelector = (mode: 'from' | 'to') => {
    setSelectionMode(mode);
    setShowMemberSelector(true);
  };

  const handleSelectMember = (member: GroupMember) => {
    if (selectionMode === 'from') {
      setFromUserId(member.userId);
    } else {
      setToUserId(member.userId);
    }
    setShowMemberSelector(false);
  };

  const getMemberName = (id: string) => {
    const m = group.members.find((m) => m.userId === id);
    return m ? resolveDisplayName(m) : 'Select User';
  };

  const inputTheme = { colors: { background: isDark ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.5)' } };
  const outlineColor = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)';

  return (
    <LiquidBackground>
      <GuardedScreen target="expenses" entityId={group.groupId} label="Hidden">
      <ScrollView contentContainerStyle={styles.container}>
        <GlassView style={styles.card}>
          <Text variant="headlineMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
            {isEditMode ? 'Edit settlement' : 'Record settlement'}
          </Text>

          <TouchableRipple onPress={() => openSelector('from')} style={styles.touchableInput}>
            <View style={[styles.fakeInput, { borderColor: outlineColor, backgroundColor: inputTheme.colors.background }]}>
              <Text variant="bodySmall" style={{ color: theme.colors.primary }}>From</Text>
              <Text variant="bodyLarge" style={{ color: theme.colors.onSurface, marginTop: 4 }}>{getMemberName(fromUserId)}</Text>
            </View>
          </TouchableRipple>

          <View style={styles.arrowContainer}>
            <IconButton icon="arrow-down" iconColor={theme.colors.onSurfaceVariant} size={20} />
          </View>

          <TouchableRipple onPress={() => openSelector('to')} style={styles.touchableInput}>
            <View style={[styles.fakeInput, { borderColor: outlineColor, backgroundColor: inputTheme.colors.background }]}>
              <Text variant="bodySmall" style={{ color: theme.colors.primary }}>To</Text>
              <Text variant="bodyLarge" style={{ color: theme.colors.onSurface, marginTop: 4 }}>{getMemberName(toUserId)}</Text>
            </View>
          </TouchableRipple>

          <TextInput
            label="Amount"
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            style={styles.field}
            mode="outlined"
            outlineColor={outlineColor}
            theme={inputTheme}
            textColor={theme.colors.onSurface}
            left={<TextInput.Affix text={group.currency} />}
            contentStyle={{ paddingHorizontal: 16 }}
          />
          {displayConversion && Number(amount) > 0 && (
            <Text
              variant="labelSmall"
              style={{ color: theme.colors.onSurfaceVariant, marginTop: -10, marginBottom: 16 }}
            >
              ≈ {formatCurrency(Number(amount) * displayConversion.rate, displayConversion.target)}{' '}
              at 1 {group.currency} = {displayConversion.rate.toFixed(4)} {displayConversion.target}
              {' · '}recorded in {group.currency}
            </Text>
          )}
          <TextInput
            label="Note"
            value={note}
            onChangeText={setNote}
            multiline
            numberOfLines={3}
            style={styles.field}
            mode="outlined"
            outlineColor={outlineColor}
            theme={inputTheme}
            textColor={theme.colors.onSurface}
            contentStyle={{ paddingTop: 16, paddingBottom: 16, textAlignVertical: 'top' }}
          />
          <View style={styles.actions}>
            <Button mode="outlined" onPress={onClose} textColor={theme.colors.onSurface}>
              Cancel
            </Button>
            <PrimaryButton
              onPress={handleSettle}
              disabled={!amount || fromUserId === toUserId}
              requestKey={isEditMode && settlementId ? `settlement-update-${settlementId}` : `settlement-create-${group.groupId}`}
              loadingMessage={isEditMode ? 'Saving settlement...' : 'Recording settlement...'}
              showGlobalOverlay
            >
              {isEditMode ? 'Update settlement' : 'Save settlement'}
            </PrimaryButton>
          </View>
        </GlassView>
      </ScrollView>

      {showMemberSelector && (
        <View style={styles.modalOverlay}>
          <GlassView role="floating" style={styles.modalContent}>
            <Text variant="titleLarge" style={[styles.modalTitle, { color: theme.colors.onSurface }]}>
              Select {selectionMode === 'from' ? 'Payer' : 'Receiver'}
            </Text>
            <ScrollView style={{ maxHeight: 400 }}>
              {group.members.map((member) => (
                <TouchableRipple
                  key={member.userId}
                  onPress={() => handleSelectMember(member)}
                  style={styles.memberItem}
                >
                  <View style={styles.memberRow}>
                    <Avatar.Text
                      size={40}
                      label={resolveInitials(member.displayName)}
                      style={{ backgroundColor: theme.colors.primaryContainer }}
                      color={theme.colors.onPrimaryContainer}
        maxFontSizeMultiplier={FONT_CAP.avatarMonogram}
      />
                    <Text variant="bodyLarge" style={{ marginLeft: 12, color: theme.colors.onSurface }}>
                      {resolveDisplayName(member)}
                    </Text>
                    {(selectionMode === 'from' ? fromUserId : toUserId) === member.userId && (
                      <IconButton icon="check" iconColor={theme.colors.primary} size={20} />
                    )}
                  </View>
                </TouchableRipple>
              ))}
            </ScrollView>
            <Button onPress={() => setShowMemberSelector(false)} style={{ marginTop: 16 }}>
              Close
            </Button>
          </GlassView>
        </View>
      )}
    </GuardedScreen>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    // Tightened 12 -> 8 (2026-08-07, compact density pass).
    gap: 8,
  },
  card: {
    padding: 24,
    borderRadius: 24,
  },
  title: {
    textAlign: 'center',
    marginBottom: 24,
    fontWeight: 'bold',
  },
  field: {
    marginBottom: 16,
  },
  touchableInput: {
    marginBottom: 8,
    borderRadius: 4,
    overflow: 'hidden',
  },
  fakeInput: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  arrowContainer: {
    alignItems: 'center',
    marginTop: -8,
    marginBottom: 0,
  },
  actions: {
    marginTop: 24,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  // Custom modal overlay styles
  modalOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000, // Ensure it's on top
    padding: 20,
  },
  modalContent: {
    width: '100%',
    maxWidth: 350,
    padding: 24,
    borderRadius: 24,
    maxHeight: '80%',
  },
  modalTitle: {
    marginBottom: 16,
    textAlign: 'center',
    fontWeight: 'bold',
  },
  memberItem: {
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
