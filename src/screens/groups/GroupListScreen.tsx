import { GroupCard } from '@/components/GroupCard';
import { colors } from '@/constants';
import { useGroups } from '@/context/GroupContext';
import type { Group } from '@/models';
import { useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { Button, Dialog, Portal, Text, TextInput } from 'react-native-paper';

interface GroupListScreenProps {
  onOpenGroup: (group: Group) => void;
}

export const GroupListScreen = ({ onOpenGroup }: GroupListScreenProps) => {
  const { groups, loading, createGroup, joinGroup } = useGroups();
  const [dialog, setDialog] = useState<'create' | 'join' | null>(null);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [inviteCode, setInviteCode] = useState('');

  const handleCreate = async () => {
    try {
      await createGroup(name.trim(), currency.trim().toUpperCase());
      setDialog(null);
      setName('');
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
            <TextInput label="Currency" value={currency} onChangeText={setCurrency} autoCapitalize="characters" />
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
});
