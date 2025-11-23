import { GlassView } from '@/components/GlassView';
import { GroupCard } from '@/components/GroupCard';
import { LiquidBackground } from '@/components/LiquidBackground';
import { colors } from '@/constants';
import { CURRENCIES } from '@/constants/currencies';
import { useGroups } from '@/context/GroupContext';
import type { Group } from '@/models';
import { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Keyboard, Platform, RefreshControl, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Button, Modal, Portal, Text, TextInput } from 'react-native-paper';

interface GroupListScreenProps {
  onOpenGroup: (group: Group) => void;
}

export const GroupListScreen = ({ onOpenGroup }: GroupListScreenProps) => {
  const { groups, loading, createGroup, joinGroup } = useGroups();
  const [dialog, setDialog] = useState<'create' | 'join' | null>(null);
  const [name, setName] = useState('');
  const [currencyInput, setCurrencyInput] = useState('USD');
  const [showCurrencyList, setShowCurrencyList] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    const showSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardVisible(true)
    );
    const hideSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardVisible(false)
    );

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  const filteredCurrencies = useMemo(() => {
    const input = currencyInput.toUpperCase();
    return CURRENCIES.filter(c => c.code.includes(input) || c.name.toUpperCase().includes(input));
  }, [currencyInput]);

  const handleCreate = async () => {
    const selectedCurrency = CURRENCIES.find(c => c.code === currencyInput.toUpperCase());
    
    if (!selectedCurrency) {
      Alert.alert('Invalid Currency', 'Please select a valid currency from the list.');
      return;
    }

    try {
      await createGroup(name.trim(), selectedCurrency.code);
      setDialog(null);
      setName('');
      setCurrencyInput('USD');
      setShowCurrencyList(false);
    } catch (error) {
      console.error('Failed to create group', error);
    }
  };

  const handleJoin = async () => {
    try {
      await joinGroup(inviteCode.trim().toUpperCase());
      setDialog(null);
      setInviteCode('');
    } catch (error) {
      console.error('Failed to join group', error);
    }
  };

  return (
    <LiquidBackground style={styles.container}>
      <FlatList
        data={groups}
        keyExtractor={(item) => item.groupId}
        renderItem={({ item }) => <GroupCard group={item} onPress={() => onOpenGroup(item)} />}
        contentContainerStyle={groups.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={<Text style={styles.empty}>No groups yet. Create one!</Text>}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => undefined} />}
      />
      <View style={styles.actions}>
        <Button mode="contained" onPress={() => setDialog('create')}>
          New group
        </Button>
        <Button mode="outlined" onPress={() => setDialog('join')}>
          Join via code
        </Button>
      </View>

      <Portal>
        <Modal
          visible={dialog === 'create'}
          onDismiss={() => setDialog(null)}
          contentContainerStyle={[
            styles.modalContainer,
            keyboardVisible && { marginBottom: 300 }
          ]}
        >
          <GlassView style={styles.glassCard}>
            <Text variant="headlineSmall" style={styles.modalTitle}>Create group</Text>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 4 }} keyboardShouldPersistTaps="handled">
              <Text variant="bodyMedium" style={styles.label}>Name</Text>
              <TextInput 
                value={name} 
                onChangeText={setName} 
                style={styles.field}
                mode="outlined"
                outlineColor="rgba(0,0,0,0.1)"
                theme={{ colors: { background: 'rgba(255,255,255,0.5)' } }}
              />
              <View>
                <Text variant="bodyMedium" style={styles.label}>Currency</Text>
                <TextInput 
                  value={currencyInput} 
                  onChangeText={(text) => {
                    setCurrencyInput(text);
                    setShowCurrencyList(true);
                  }}
                  onFocus={() => setShowCurrencyList(true)}
                  autoCapitalize="characters"
                  mode="outlined"
                  outlineColor="rgba(0,0,0,0.1)"
                  theme={{ colors: { background: 'rgba(255,255,255,0.5)' } }}
                  style={showCurrencyList ? { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : undefined}
                />
                {showCurrencyList && (
                  <View style={styles.currencyList}>
                    <ScrollView nestedScrollEnabled={true} keyboardShouldPersistTaps="handled">
                      {filteredCurrencies.slice(0, 50).map((item) => (
                        <TouchableOpacity 
                          key={item.code}
                          style={styles.currencyItem} 
                          onPress={() => {
                            setCurrencyInput(item.code);
                            setShowCurrencyList(false);
                          }}
                        >
                          <Text style={{ fontWeight: 'bold' }}>{item.code}</Text>
                          <Text numberOfLines={1} style={{ flex: 1, marginLeft: 8, color: colors.muted }}>{item.name}</Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </View>
                )}
              </View>
            </ScrollView>
            <View style={styles.modalActions}>
              <Button onPress={() => setDialog(null)}>Cancel</Button>
              <Button mode="contained" onPress={handleCreate} disabled={!name}>
                Create
              </Button>
            </View>
          </GlassView>
        </Modal>

        <Modal
          visible={dialog === 'join'}
          onDismiss={() => setDialog(null)}
          contentContainerStyle={[
            styles.modalContainer,
            keyboardVisible && { marginBottom: 150 }
          ]}
        >
          <GlassView style={styles.glassCard}>
            <Text variant="headlineSmall" style={styles.modalTitle}>Join group</Text>
            <Text variant="bodyMedium" style={styles.label}>Invite code</Text>
            <TextInput
              value={inviteCode}
              onChangeText={setInviteCode}
              autoCapitalize="characters"
              mode="outlined"
              outlineColor="rgba(0,0,0,0.1)"
              theme={{ colors: { background: 'rgba(255,255,255,0.5)' } }}
            />
            <View style={styles.modalActions}>
              <Button onPress={() => setDialog(null)}>Cancel</Button>
              <Button mode="contained" onPress={handleJoin} disabled={!inviteCode}>
                Join
              </Button>
            </View>
          </GlassView>
        </Modal>
      </Portal>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  empty: {
    textAlign: 'center',
    color: colors.muted,
  },
  field: {
    marginBottom: 12,
  },
  label: {
    marginBottom: 4,
    marginLeft: 4,
    fontWeight: '500',
    color: '#555',
  },
  currencyList: {
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.1)',
    borderTopWidth: 0,
    maxHeight: 150,
    backgroundColor: 'rgba(255,255,255,0.85)',
    elevation: 4,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
  },
  currencyItem: {
    flexDirection: 'row',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.05)',
    alignItems: 'center',
  },
  modalContainer: {
    padding: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glassCard: {
    width: '100%',
    maxWidth: 400,
    padding: 24,
    borderRadius: 30,
  },
  modalTitle: {
    marginBottom: 20,
    textAlign: 'center',
    fontWeight: 'bold',
    color: '#333',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 20,
    gap: 10,
  },
});