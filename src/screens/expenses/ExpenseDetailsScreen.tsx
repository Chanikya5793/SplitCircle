import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import { formatCurrency } from '@/utils/currency';
import { useNavigation } from '@react-navigation/native';
import * as Linking from 'expo-linking';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Image, Modal, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Button, Chip, Dialog, Divider, IconButton, Portal, Text, TextInput } from 'react-native-paper';

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

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: '',
      headerTransparent: true,
      headerTintColor: theme.colors.primary,
    });
  }, [navigation, theme.colors.primary]);

  const headerOpacity = scrollY.interpolate({
    inputRange: [40, 80],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

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
        <Text style={{ color: theme.colors.onSurface }}>Expense not found</Text>
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
    <LiquidBackground>
      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]}>
        <GlassView style={[styles.stickyHeaderGlass, { backgroundColor: isDark ? 'rgba(30, 30, 30, 0.8)' : 'rgba(255, 255, 255, 0.8)' }]}>
          <Text variant="titleMedium" style={[styles.stickyHeaderTitle, { color: theme.colors.onSurface }]} numberOfLines={1}>
            {expense.title}
          </Text>
        </GlassView>
      </Animated.View>

      <ScrollView
        contentContainerStyle={styles.container}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: false }
        )}
        scrollEventThrottle={16}
      >
        <View style={{ height: 60 }} />
        <GlassView style={styles.card}>
          <View style={styles.header}>
            <View>
              <Text variant="headlineMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>{expense.title}</Text>
              <Text variant="titleMedium" style={[styles.amount, { color: theme.colors.onSurface }]}>
                {formatCurrency(expense.amount, group.currency)}
              </Text>
            </View>
            <Chip icon="tag" style={{ backgroundColor: theme.colors.secondaryContainer }} textStyle={{ color: theme.colors.onSecondaryContainer }}>{expense.category}</Chip>
          </View>

          <Text style={[styles.meta, { color: theme.colors.onSurfaceVariant }]}>
            Added by {payerName} on {new Date(expense.createdAt).toLocaleDateString()}
          </Text>

          {expense.receipt?.url && (
            <View style={styles.section}>
              <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>Receipt</Text>
              {expense.receipt.fileName?.toLowerCase().endsWith('.pdf') ||
                expense.receipt.fileName?.toLowerCase().endsWith('.doc') ||
                expense.receipt.fileName?.toLowerCase().endsWith('.docx') ? (
                <TouchableOpacity
                  style={[styles.documentContainer, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : '#f0f0f0' }]}
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
                  <Image source={{ uri: expense.receipt.url }} style={[styles.receiptThumbnail, { backgroundColor: isDark ? '#333' : '#f0f0f0' }]} resizeMode="cover" />
                </TouchableOpacity>
              )}
            </View>
          )}

          <Divider style={[styles.divider, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)' }]} />

          <View style={styles.section}>
            <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
              Paid by
            </Text>
            <View style={styles.row}>
              <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>{payerName}</Text>
              <Text variant="bodyLarge" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
                {formatCurrency(expense.amount, group.currency)}
              </Text>
            </View>
          </View>

          <Divider style={[styles.divider, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)' }]} />

          <View style={styles.section}>
            <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
              Split with
            </Text>
            {expense.participants.map((p) => (
              <View key={p.userId} style={styles.row}>
                <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>{memberMap[p.userId] || 'Unknown'}</Text>
                <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>{formatCurrency(p.share, group.currency)}</Text>
              </View>
            ))}
          </View>

          <Divider style={[styles.divider, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)' }]} />

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
                  <Button mode="contained" onPress={handleSaveNote}>
                    Save
                  </Button>
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

        <Portal>
          <Dialog visible={showDeleteDialog} onDismiss={() => setShowDeleteDialog(false)} style={{ backgroundColor: theme.colors.surface }}>
            <Dialog.Title style={{ color: theme.colors.onSurface }}>Delete Expense</Dialog.Title>
            <Dialog.Content>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>Are you sure you want to delete this expense? This cannot be undone.</Text>
            </Dialog.Content>
            <Dialog.Actions>
              <Button onPress={() => setShowDeleteDialog(false)}>Cancel</Button>
              <Button textColor={theme.colors.error} onPress={handleDelete}>
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
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    paddingBottom: 180,
    flexGrow: 1,
  },
  card: {
    padding: 24,
    borderRadius: 24,
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
  },
  documentContainer: {
    flexDirection: 'row',
    alignItems: 'center',
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
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingTop: 50,
    paddingHorizontal: 16,
    paddingBottom: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stickyHeaderGlass: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 20,
    maxWidth: '80%',
  },
  stickyHeaderTitle: {
    fontWeight: 'bold',
  },
});
