import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { Group } from '@/models';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, Text, TextInput } from 'react-native-paper';

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

  const handleSettle = async () => {
    await settleUp(group.groupId, {
      fromUserId,
      toUserId,
      amount: Number(amount),
      note,
    });
    onClose();
  };

  const inputTheme = { colors: { background: isDark ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.5)' } };
  const outlineColor = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)';

  return (
    <LiquidBackground>
      <ScrollView contentContainerStyle={styles.container}>
        <GlassView style={styles.card}>
          <Text variant="headlineMedium" style={[styles.title, { color: theme.colors.onSurface }]}>Record settlement</Text>
          <TextInput
            label="From"
            value={fromUserId}
            onChangeText={setFromUserId}
            style={styles.field}
            mode="outlined"
            outlineColor={outlineColor}
            theme={inputTheme}
            textColor={theme.colors.onSurface}
          />
          <TextInput
            label="To"
            value={toUserId}
            onChangeText={setToUserId}
            style={styles.field}
            mode="outlined"
            outlineColor={outlineColor}
            theme={inputTheme}
            textColor={theme.colors.onSurface}
          />
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
          />
          <View style={styles.actions}>
            <Button mode="outlined" onPress={onClose}>
              Cancel
            </Button>
            <Button mode="contained" onPress={handleSettle} disabled={!amount}>
              Save settlement
            </Button>
          </View>
        </GlassView>
      </ScrollView>
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
    marginBottom: 16,
  },
  field: {
    marginBottom: 8,
  },
  actions: {
    marginTop: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
