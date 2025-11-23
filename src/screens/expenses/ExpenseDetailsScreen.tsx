import { colors, ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { formatCurrency } from '@/utils/currency';
import * as Linking from 'expo-linking';
import { useMemo, useState } from 'react';
import { Alert, Image, Modal, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Button, Chip, Dialog, Divider, IconButton, Portal, Text, TextInput } from 'react-native-paper';

interface ExpenseDetailsScreenProps {
  route: any;
  navigation: any;
}

export const ExpenseDetailsScreen = ({ route, navigation }: ExpenseDetailsScreenProps) => {
  const { groupId, expenseId } = route.params;
  const { groups, deleteExpense, updateExpense } = useGroups();
  const { user } = useAuth();

  const group = groups.find((g) => g.groupId === groupId);
  const expense = group?.expenses.find((e) => e.expenseId === expenseId);

  const [note, setNote] = useState(expense?.notes || '');
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showImageModal, setShowImageModal] = useState(false);

  const memberMap = useMemo(
    () => (group ? Object.fromEntries(group.members.map((m) => [m.userId, m.displayName])) : {}),
    [group],
  );

  if (!group || !expense) {
    return (
      <View style={styles.center}>
        <Text>Expense not found</Text>
      </View>
    );
  }

  const handleDelete = async () => {
    try {
      await deleteExpense(groupId, expenseId);
      navigation.goBack();
    } catch (error) {
      Alert.alert('Error', 'Failed to delete expense');
    }
  };

  const handleSaveNote = async () => {
    try {
      await updateExpense(groupId, { ...expense, notes: note });
      setIsEditingNote(false);
    } catch (error) {
      Alert.alert('Error', 'Failed to save note');
    }
  };

  const handleEditExpense = () => {
    navigation.navigate(ROUTES.APP.ADD_EXPENSE, { groupId, expenseId });
  };

  const payerName = memberMap[expense.paidBy] || 'Unknown';

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <View>
          <Text variant="headlineMedium">{expense.title}</Text>
          <Text variant="titleMedium" style={styles.amount}>
            {formatCurrency(expense.amount, group.currency)}
          </Text>
        </View>
        <Chip icon="tag">{expense.category}</Chip>
      </View>

      <Text style={styles.meta}>
        Added by {payerName} on {new Date(expense.createdAt).toLocaleDateString()}
      </Text>

      {expense.receipt?.url && (
        <View style={styles.section}>
          <Text variant="titleMedium" style={styles.sectionTitle}>Receipt</Text>
          {expense.receipt.fileName?.toLowerCase().endsWith('.pdf') || 
           expense.receipt.fileName?.toLowerCase().endsWith('.doc') || 
           expense.receipt.fileName?.toLowerCase().endsWith('.docx') ? (
            <TouchableOpacity 
              style={styles.documentContainer} 
              onPress={() => Linking.openURL(expense.receipt!.url!)}
            >
              <IconButton icon="file-document" size={40} />
              <Text variant="bodyLarge" style={{ flex: 1 }}>
                {expense.receipt.fileName || 'Document'}
              </Text>
              <IconButton icon="open-in-new" size={20} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={() => setShowImageModal(true)}>
              <Image source={{ uri: expense.receipt.url }} style={styles.receiptThumbnail} resizeMode="cover" />
            </TouchableOpacity>
          )}
        </View>
      )}

      <Divider style={styles.divider} />

      <View style={styles.section}>
        <Text variant="titleMedium" style={styles.sectionTitle}>
          Paid by
        </Text>
        <View style={styles.row}>
          <Text variant="bodyLarge">{payerName}</Text>
          <Text variant="bodyLarge" style={{ fontWeight: 'bold' }}>
            {formatCurrency(expense.amount, group.currency)}
          </Text>
        </View>
      </View>

      <Divider style={styles.divider} />

      <View style={styles.section}>
        <Text variant="titleMedium" style={styles.sectionTitle}>
          Split with
        </Text>
        {expense.participants.map((p) => (
          <View key={p.userId} style={styles.row}>
            <Text variant="bodyLarge">{memberMap[p.userId] || 'Unknown'}</Text>
            <Text variant="bodyLarge">{formatCurrency(p.share, group.currency)}</Text>
          </View>
        ))}
      </View>

      <Divider style={styles.divider} />

      <View style={styles.section}>
        <View style={styles.row}>
          <Text variant="titleMedium" style={styles.sectionTitle}>
            Notes & Comments
          </Text>
          {!isEditingNote && (
            <IconButton icon="pencil" size={20} onPress={() => setIsEditingNote(true)} />
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
              style={{ marginBottom: 8 }}
            />
            <View style={styles.noteActions}>
              <Button onPress={() => setIsEditingNote(false)}>Cancel</Button>
              <Button mode="contained" onPress={handleSaveNote}>
                Save
              </Button>
            </View>
          </View>
        ) : (
          <Text variant="bodyMedium" style={{ color: note ? colors.text : colors.muted }}>
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
          textColor={colors.danger}
          style={{ flex: 1, borderColor: colors.danger }}
          onPress={() => setShowDeleteDialog(true)}
        >
          Delete
        </Button>
      </View>

      <Portal>
        <Dialog visible={showDeleteDialog} onDismiss={() => setShowDeleteDialog(false)}>
          <Dialog.Title>Delete Expense</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">Are you sure you want to delete this expense? This cannot be undone.</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setShowDeleteDialog(false)}>Cancel</Button>
            <Button textColor={colors.danger} onPress={handleDelete}>
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

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
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    backgroundColor: colors.background,
    flexGrow: 1,
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
    marginBottom: 8,
  },
  amount: {
    fontWeight: 'bold',
    fontSize: 24,
    marginTop: 4,
  },
  meta: {
    color: colors.muted,
    marginBottom: 16,
  },
  divider: {
    marginVertical: 16,
  },
  section: {
    marginBottom: 8,
  },
  sectionTitle: {
    marginBottom: 12,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
    alignItems: 'center',
  },
  noteActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  actions: {
    marginTop: 32,
    flexDirection: 'row',
    gap: 16,
    marginBottom: 32,
  },
  receiptThumbnail: {
    width: '100%',
    height: 200,
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
  },
  documentContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
    padding: 8,
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
});
