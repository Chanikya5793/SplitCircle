import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { Group, GroupMember } from '@/models';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Avatar, Button, IconButton, Text, TextInput, TouchableRipple } from 'react-native-paper';

interface SettlementsScreenProps {
  group: Group;
  onClose: () => void;
}

export const SettlementsScreen = ({ group, onClose }: SettlementsScreenProps) => {
  const { settleUp } = useGroups();
  const { theme, isDark } = useTheme();
  const [fromUserId, setFromUserId] = useState(group.members[0]?.userId ?? '');
  const [toUserId, setToUserId] = useState(group.members[1]?.userId ?? '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  const [showMemberSelector, setShowMemberSelector] = useState(false);
  const [selectionMode, setSelectionMode] = useState<'from' | 'to'>('from');

  const handleSettle = async () => {
    await settleUp(group.groupId, {
      fromUserId,
      toUserId,
      amount: Number(amount),
      note,
    });
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
    return m ? m.displayName : 'Select User';
  };

  const inputTheme = { colors: { background: isDark ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.5)' } };
  const outlineColor = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)';

  return (
    <LiquidBackground>
      <ScrollView contentContainerStyle={styles.container}>
        <GlassView style={styles.card}>
          <Text variant="headlineMedium" style={[styles.title, { color: theme.colors.onSurface }]}>Record settlement</Text>

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
            contentStyle={{ paddingTop: 0, paddingBottom: 0, height: 50, textAlignVertical: 'center' }}
          />
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
            contentStyle={{ paddingTop: 8, paddingBottom: 8, textAlignVertical: 'top' }}
          />
          <View style={styles.actions}>
            <Button mode="outlined" onPress={onClose} textColor={theme.colors.onSurface}>
              Cancel
            </Button>
            <Button mode="contained" onPress={handleSettle} disabled={!amount}>
              Save settlement
            </Button>
          </View>
        </GlassView>
      </ScrollView>

      {showMemberSelector && (
        <View style={styles.modalOverlay}>
          <GlassView style={styles.modalContent}>
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
                      label={member.displayName.slice(0, 2).toUpperCase()}
                      style={{ backgroundColor: theme.colors.primaryContainer }}
                      color={theme.colors.onPrimaryContainer}
                    />
                    <Text variant="bodyLarge" style={{ marginLeft: 12, color: theme.colors.onSurface }}>
                      {member.displayName}
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
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 12,
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
