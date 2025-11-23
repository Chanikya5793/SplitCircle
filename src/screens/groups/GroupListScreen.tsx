import { GroupCard } from '@/components/GroupCard';
import { colors } from '@/constants';
import { CURRENCIES } from '@/constants/currencies';
import { useGroups } from '@/context/GroupContext';
import type { Group } from '@/models';
import { useMemo, useState } from 'react';
import { Alert, FlatList, RefreshControl, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Button, Dialog, Portal, Text, TextInput } from 'react-native-paper';

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
    <View style={styles.container}>
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
        <Dialog visible={dialog === 'create'} onDismiss={() => setDialog(null)}>
          <Dialog.Title>Create group</Dialog.Title>
          <Dialog.Content>
            <TextInput label="Name" value={name} onChangeText={setName} style={styles.field} />
            <View>
              <TextInput 
                label="Currency" 
                value={currencyInput} 
                onChangeText={(text) => {
                  setCurrencyInput(text);
                  setShowCurrencyList(true);
                }}
                onFocus={() => setShowCurrencyList(true)}
                autoCapitalize="characters" 
              />
              {showCurrencyList && (
                <View style={styles.currencyList}>
                  <FlatList
                    data={filteredCurrencies}
                    keyExtractor={(item) => item.code}
                    keyboardShouldPersistTaps="handled"
                    style={{ maxHeight: 150 }}
                    renderItem={({ item }) => (
                      <TouchableOpacity 
                        style={styles.currencyItem} 
                        onPress={() => {
                          setCurrencyInput(item.code);
                          setShowCurrencyList(false);
                        }}
                      >
                        <Text style={{ fontWeight: 'bold' }}>{item.code}</Text>
                        <Text numberOfLines={1} style={{ flex: 1, marginLeft: 8, color: colors.muted }}>{item.name}</Text>
                      </TouchableOpacity>
                    )}
                  />
                </View>
              )}
            </View>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDialog(null)}>Cancel</Button>
            <Button onPress={handleCreate} disabled={!name}>
              Create
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={dialog === 'join'} onDismiss={() => setDialog(null)}>
          <Dialog.Title>Join group</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Invite code"
              value={inviteCode}
              onChangeText={setInviteCode}
              autoCapitalize="characters"
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDialog(null)}>Cancel</Button>
            <Button onPress={handleJoin} disabled={!inviteCode}>
              Join
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
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
  currencyList: {
    borderWidth: 1,
    borderColor: colors.border,
    borderTopWidth: 0,
    maxHeight: 150,
    backgroundColor: 'white',
    elevation: 4,
  },
  currencyItem: {
    flexDirection: 'row',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    alignItems: 'center',
  },
});
