import { FloatingLabelInput } from '@/components/FloatingLabelInput';
import { GlassView } from '@/components/GlassView';
import { GroupCard } from '@/components/GroupCard';
import { LiquidBackground } from '@/components/LiquidBackground';
import { CURRENCIES } from '@/constants/currencies';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { Group } from '@/models';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Keyboard, Platform, RefreshControl, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Button, Modal, Portal, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface GroupListScreenProps {
  onOpenGroup: (group: Group) => void;
}

export const GroupListScreen = ({ onOpenGroup }: GroupListScreenProps) => {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { groups, loading, createGroup, joinGroup } = useGroups();
  const { theme, isDark } = useTheme();
  const [dialog, setDialog] = useState<'create' | 'join' | null>(null);
  const [name, setName] = useState('');
  const [currencyInput, setCurrencyInput] = useState('USD');
  const [showCurrencyList, setShowCurrencyList] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const scrollY = useRef(new Animated.Value(0)).current;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: '',
      headerTransparent: true,
    });
  }, [navigation]);

  const headerOpacity = scrollY.interpolate({
    inputRange: [0, 40],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

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
      Alert.alert('Error', 'Failed to create group');
    }
  };

  const handleJoin = async () => {
    try {
      await joinGroup(inviteCode.trim().toUpperCase());
      setDialog(null);
      setInviteCode('');
    } catch (error) {
      console.error('Failed to join group', error);
      Alert.alert('Error', 'Failed to join group');
    }
  };

  return (
    <LiquidBackground style={styles.container}>
      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]}>
        <GlassView style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={[styles.stickyHeaderTitle, { color: theme.colors.onSurface }]}>Groups</Text>
        </GlassView>
      </Animated.View>

      <Animated.FlatList
        data={groups}
        keyExtractor={(item) => item.groupId}
        renderItem={({ item }) => <GroupCard group={item} onPress={() => onOpenGroup(item)} />}
        contentContainerStyle={[
          groups.length === 0 ? styles.emptyContainer : undefined,
          { paddingTop: 80, paddingBottom: 100 + insets.bottom, paddingHorizontal: 16 }
        ]}
        ListHeaderComponent={
          <View style={styles.headerContainer}>
            <Text variant="displaySmall" style={[styles.headerTitle, { color: theme.colors.onSurface }]}>Groups</Text>
          </View>
        }
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true }
        )}
        scrollEventThrottle={16}
        removeClippedSubviews={true}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={5}
        ListEmptyComponent={
          !loading ? (
            <Text style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>No groups yet. Create one!</Text>
          ) : null
        }
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => undefined} tintColor={theme.colors.primary} />}
      />

      <View style={[styles.actions, { bottom: 60 + insets.bottom }]}>
        <Button mode="contained" onPress={() => setDialog('create')}>
          New group
        </Button>

        <TouchableOpacity
          onPress={() => setDialog('join')}
          activeOpacity={0.8}
          style={{
            borderRadius: 15,
            overflow: 'hidden',
            borderWidth: 0,
            borderColor: 'rgba(0,0,0,0.08)',
            minWidth: 100,
          }}
        >
          {/* GlassView provides the blurred/frosted fill inside the button */}
          <GlassView style={{ paddingVertical: 12, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: theme.colors.primary, fontWeight: '600' }}>Join via code</Text>
          </GlassView>
        </TouchableOpacity>
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
            <Text variant="headlineSmall" style={[styles.modalTitle, { color: theme.colors.onSurface }]}>Create group</Text>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 4 }} keyboardShouldPersistTaps="handled">
              <FloatingLabelInput
                label="Name"
                value={name}
                onChangeText={setName}
                style={styles.field}
              />
              <View>
                <FloatingLabelInput
                  label="Currency"
                  value={currencyInput}
                  onChangeText={(text: string) => {
                    setCurrencyInput(text);
                    setShowCurrencyList(true);
                  }}
                  onFocus={() => setShowCurrencyList(true)}
                  autoCapitalize="characters"
                  style={showCurrencyList ? { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : undefined}
                />
                {showCurrencyList && (
                  <View style={[styles.currencyList, { backgroundColor: isDark ? 'rgba(30,30,30,0.95)' : 'rgba(255,255,255,0.85)', borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }]}>
                    <ScrollView nestedScrollEnabled={true} keyboardShouldPersistTaps="handled">
                      {filteredCurrencies.slice(0, 50).map((item) => (
                        <TouchableOpacity
                          key={item.code}
                          style={[styles.currencyItem, { borderBottomColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }]}
                          onPress={() => {
                            setCurrencyInput(item.code);
                            setShowCurrencyList(false);
                          }}
                        >
                          <Text style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>{item.code}</Text>
                          <Text numberOfLines={1} style={{ flex: 1, marginLeft: 8, color: theme.colors.onSurfaceVariant }}>{item.name}</Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </View>
                )}
              </View>
            </ScrollView>
            <View style={styles.modalActions}>
              <Button onPress={() => setDialog(null)} textColor={theme.colors.primary}>Cancel</Button>
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
            <Text variant="headlineSmall" style={[styles.modalTitle, { color: theme.colors.onSurface }]}>Join group</Text>
            <FloatingLabelInput
              label="Invite code"
              value={inviteCode}
              onChangeText={setInviteCode}
              autoCapitalize="characters"
            />
            <View style={styles.modalActions}>
              <Button onPress={() => setDialog(null)} textColor={theme.colors.primary}>Cancel</Button>
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
  },
  actions: {
    position: 'absolute',
    left: 20,
    right: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    zIndex: 10,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  empty: {
    textAlign: 'center',
  },
  field: {
    marginBottom: 0,
  },
  currencyList: {
    borderWidth: 1,
    borderTopWidth: 0,
    maxHeight: 150,
    elevation: 4,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
  },
  currencyItem: {
    flexDirection: 'row',
    padding: 12,
    borderBottomWidth: 1,
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
    marginBottom: 0, // Spacing between title and first field
    textAlign: 'center',
    fontWeight: 'bold',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 20,
    gap: 10,
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
  },
  stickyHeaderTitle: {
    fontWeight: 'bold',
  },
  headerContainer: {
    paddingHorizontal: 8,
    paddingBottom: 16,
    marginTop: 16,
  },
  headerTitle: {
    fontWeight: 'bold',
  },
});