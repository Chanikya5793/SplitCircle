import { GlassView } from '@/components/GlassView';
import { GroupCard } from '@/components/GroupCard';
import { LiquidBackground } from '@/components/LiquidBackground';
import { colors } from '@/constants';
import { CURRENCIES } from '@/constants/currencies';
import { useGroups } from '@/context/GroupContext';
import type { Group } from '@/models';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, FlatList, Keyboard, Platform, RefreshControl, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
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
            <FloatingLabelInput
              label="Invite code"
              value={inviteCode}
              onChangeText={setInviteCode}
              autoCapitalize="characters"
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

interface FloatingLabelInputProps extends React.ComponentProps<typeof TextInput> {
  label: string;
}

const FloatingLabelInput = ({ label, value, style, onFocus, onBlur, ...props }: FloatingLabelInputProps) => {
  const [isFocused, setIsFocused] = useState(false);
  const animatedValue = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(animatedValue, {
      toValue: (isFocused || value) ? 1 : 0,
      duration: 200,
      useNativeDriver: false,
    }).start();
  }, [isFocused, value]);

  const labelStyle = {
    position: 'absolute' as const,
    left: animatedValue.interpolate({
      inputRange: [0, 1],
      outputRange: [16, 10], // [Start X, End X] - Adjust horizontal position
    }),
    top: animatedValue.interpolate({
      inputRange: [0, 1],
      outputRange: [42, 5], // [Start Y, End Y] - Adjust vertical position
    }),
    fontSize: animatedValue.interpolate({
      inputRange: [0, 1],
      outputRange: [19, 16], // [Start Size, End Size] - Adjust font size
    }),
    color: animatedValue.interpolate({
      inputRange: [0, 1],
      outputRange: [colors.muted, '#555'],
    }),
    zIndex: 1,
  };

  return (
    <View style={{ marginBottom: 12, paddingTop: 24 }}>
      <Animated.Text style={labelStyle} pointerEvents="none">
        {label}
      </Animated.Text>
      <TextInput
        {...props}
        value={value}
        style={style}
        onFocus={(e) => {
          setIsFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setIsFocused(false);
          onBlur?.(e);
        }}
        mode="outlined"
        outlineColor="rgba(0,0,0,0.1)"
        theme={{ colors: { background: 'rgba(255,255,255,0.5)' } }}
      />
    </View>
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