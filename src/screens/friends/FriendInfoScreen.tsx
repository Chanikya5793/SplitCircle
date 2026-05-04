import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useCallContext } from '@/context/CallContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import { db } from '@/firebase';
import { computeFriendBalances } from '@/utils/friendBalances';
import { lightHaptic, selectionHaptic } from '@/utils/haptics';
import { useNavigation, useRoute } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { doc, onSnapshot } from 'firebase/firestore';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { Avatar, Button, Divider, IconButton, List, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface FriendInfoParams {
  userId: string;
  displayName?: string;
  photoURL?: string;
  backTitle?: string;
}

interface UserProfile {
  userId: string;
  displayName?: string;
  email?: string;
  photoURL?: string;
  bio?: string;
  phoneNumber?: string;
  status?: string;
  joinedAt?: number;
}

const formatBalance = (amount: number, currency: string): string => {
  const abs = Math.abs(amount);
  return `${currency} ${abs >= 10 ? abs.toFixed(0) : abs.toFixed(2)}`;
};

export const FriendInfoScreen = () => {
  const navigation = useNavigation<any>();
  const route = useRoute();
  const params = (route.params ?? {}) as FriendInfoParams;
  const { user } = useAuth();
  const { theme } = useTheme();
  const { groups } = useGroups();
  const { ensureDirectThread } = useChat();
  const { startCallSession } = useCallContext();
  const insets = useSafeAreaInsets();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [note, setNote] = useState('');
  const [noteEditing, setNoteEditing] = useState(false);
  const [navigatingGroupId, setNavigatingGroupId] = useState<string | null>(null);
  const noteInputRef = useRef<any>(null);
  const noteKey = `friend_note_${params.userId}`;

  useLayoutEffect(() => {
    navigation.setOptions({
      title: params.displayName ?? 'Friend',
      headerTransparent: true,
    });
  }, [navigation, params.displayName]);

  useEffect(() => {
    if (!params.userId) return;
    const ref = doc(db, 'users', params.userId);
    const unsubscribe = onSnapshot(
      ref,
      (snapshot) => {
        if (!snapshot.exists()) {
          setProfile({ userId: params.userId, displayName: params.displayName, photoURL: params.photoURL });
          return;
        }
        const data = snapshot.data() as Record<string, unknown>;
        setProfile({
          userId: params.userId,
          displayName: (data.displayName as string) ?? params.displayName,
          email: data.email as string | undefined,
          photoURL: (data.photoURL as string) ?? params.photoURL,
          bio: data.bio as string | undefined,
          phoneNumber: data.phoneNumber as string | undefined,
          status: data.status as string | undefined,
          joinedAt: data.joinedAt as number | undefined,
        });
      },
      (error) => {
        console.warn('FriendInfoScreen profile load failed', error);
        setProfile({ userId: params.userId, displayName: params.displayName, photoURL: params.photoURL });
      },
    );
    return unsubscribe;
  }, [params.userId, params.displayName, params.photoURL]);

  useEffect(() => {
    AsyncStorage.getItem(noteKey).then((saved) => {
      if (saved !== null) setNote(saved);
    }).catch(() => {});
  }, [noteKey]);

  const saveNote = useCallback((value: string) => {
    setNote(value);
    AsyncStorage.setItem(noteKey, value).catch(() => {});
  }, [noteKey]);

  const handleGroupPress = useCallback((group: { groupId: string; name: string }) => {
    lightHaptic();
    setNavigatingGroupId(group.groupId);
    const backTitle = profile?.displayName ?? params.displayName ?? 'Friend';
    setTimeout(() => {
      navigation.navigate(ROUTES.APP.ROOT, {
        screen: ROUTES.APP.GROUPS_TAB,
        params: {
          screen: ROUTES.APP.GROUP_DETAILS,
          params: {
            groupId: group.groupId,
            initialTitle: group.name,
            backTitle,
          },
        },
      });
      setNavigatingGroupId(null);
    }, 80);
  }, [navigation, profile?.displayName, params.displayName]);

  const sharedGroups = useMemo(
    () => groups.filter((group) => group.members?.some((m) => m.userId === params.userId)),
    [groups, params.userId],
  );

  const balances = useMemo(() => {
    if (!user?.userId) return [];
    const all = computeFriendBalances(user.userId, groups);
    return all[params.userId] ?? [];
  }, [user?.userId, groups, params.userId]);

  const balanceSum = balances.reduce((s, b) => s + b.amount, 0);
  const balanceColor = Math.abs(balanceSum) < 0.01
    ? theme.colors.onSurfaceVariant
    : balanceSum > 0
      ? '#10B981'
      : '#EF4444';

  const placeCall = async (type: 'audio' | 'video') => {
    if (!user || !profile) return;
    selectionHaptic();
    try {
      const chatId = await ensureDirectThread({
        userId: profile.userId,
        displayName: profile.displayName ?? 'Friend',
        photoURL: profile.photoURL,
        status: 'online',
      });
      startCallSession({ chatId, type });
    } catch (error) {
      console.warn('FriendInfoScreen placeCall failed', error);
      Alert.alert('Could not place call', 'Please try again.');
    }
  };

  const openDirectChat = async () => {
    if (!user || !profile) return;
    lightHaptic();
    try {
      const chatId = await ensureDirectThread({
        userId: profile.userId,
        displayName: profile.displayName ?? 'Friend',
        photoURL: profile.photoURL,
        status: 'online',
      });
      navigation.navigate(ROUTES.APP.GROUP_CHAT, {
        chatId,
        initialTitle: profile.displayName ?? 'Friend',
        backTitle: params.backTitle ?? 'Friend Info',
      });
    } catch (error) {
      console.warn('FriendInfoScreen openDirectChat failed', error);
    }
  };

  const displayName = profile?.displayName ?? params.displayName ?? 'Friend';
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <LiquidBackground>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 64, paddingBottom: insets.bottom + 32 }]}
      >
        {/* Hero card — avatar centered, name, bio, action row */}
        <GlassView style={styles.heroCard}>
          <View style={styles.avatarWrapper}>
            {profile?.photoURL ? (
              <Avatar.Image size={112} source={{ uri: profile.photoURL }} />
            ) : (
              <Avatar.Text
                size={112}
                label={initials}
                style={{ backgroundColor: theme.colors.primary }}
                color={theme.colors.onPrimary}
              />
            )}
          </View>
          <Text variant="headlineSmall" style={[styles.heroName, { color: theme.colors.onSurface }]}>
            {displayName}
          </Text>
          {profile?.email ? (
            <Text
              variant="bodyMedium"
              style={[styles.heroEmail, { color: theme.colors.onSurfaceVariant }]}
            >
              {profile.email}
            </Text>
          ) : null}
          {profile?.bio ? (
            <Text
              variant="bodyMedium"
              style={[styles.heroBio, { color: theme.colors.onSurface }]}
            >
              {profile.bio}
            </Text>
          ) : null}

          <View style={styles.actionRow}>
            <Button mode="contained-tonal" icon="message" onPress={openDirectChat}>
              Message
            </Button>
            <IconButton
              mode="contained-tonal"
              icon="phone"
              size={22}
              onPress={() => placeCall('audio')}
              accessibilityLabel="Audio call"
            />
            <IconButton
              mode="contained-tonal"
              icon="video"
              size={22}
              onPress={() => placeCall('video')}
              accessibilityLabel="Video call"
            />
          </View>
        </GlassView>

        {/* Balance section */}
        <GlassView style={styles.sectionCard}>
          <List.Section>
            <List.Subheader>Balance</List.Subheader>
            {balances.length === 0 ? (
              <List.Item title="Settled up" left={(props) => <List.Icon {...props} icon="check-circle-outline" />} />
            ) : (
              <List.Item
                title={balanceSum > 0 ? `Owes you ${balances.map((b) => formatBalance(b.amount, b.currency)).join(' · ')}` : `You owe ${balances.map((b) => formatBalance(b.amount, b.currency)).join(' · ')}`}
                titleStyle={{ color: balanceColor }}
                left={(props) => <List.Icon {...props} icon={balanceSum > 0 ? 'cash-plus' : 'cash-minus'} color={balanceColor} />}
              />
            )}
          </List.Section>
        </GlassView>

        {/* Private notes — only visible to you, stored locally */}
        <GlassView style={styles.sectionCard}>
          <List.Section>
            <List.Subheader>Private Note</List.Subheader>
            <View style={styles.noteContainer}>
              {noteEditing ? (
                <TextInput
                  ref={noteInputRef}
                  value={note}
                  onChangeText={saveNote}
                  onBlur={() => setNoteEditing(false)}
                  multiline
                  placeholder="Add a private note about this friend…"
                  placeholderTextColor={theme.colors.onSurfaceVariant}
                  style={[styles.noteInput, { color: theme.colors.onSurface }]}
                  autoFocus
                />
              ) : (
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => {
                    setNoteEditing(true);
                    setTimeout(() => noteInputRef.current?.focus(), 50);
                  }}
                  style={styles.noteTouchable}
                >
                  <Text
                    style={[
                      styles.noteText,
                      { color: note ? theme.colors.onSurface : theme.colors.onSurfaceVariant },
                    ]}
                    numberOfLines={4}
                  >
                    {note || 'Tap to add a private note…'}
                  </Text>
                  <IconButton icon="pencil-outline" size={16} iconColor={theme.colors.onSurfaceVariant} style={styles.noteEditIcon} />
                </TouchableOpacity>
              )}
              <Text style={[styles.noteHint, { color: theme.colors.onSurfaceVariant }]}>
                Only visible to you · not shared
              </Text>
            </View>
          </List.Section>
        </GlassView>

        {/* Groups in common */}
        {sharedGroups.length > 0 && (
          <GlassView style={styles.sectionCard}>
            <List.Section>
              <List.Subheader>{sharedGroups.length === 1 ? '1 group in common' : `${sharedGroups.length} groups in common`}</List.Subheader>
              {sharedGroups.map((group, index) => (
                <View key={group.groupId}>
                  {index > 0 ? <Divider /> : null}
                  <List.Item
                    title={group.name}
                    description={`${group.members?.length ?? 0} members`}
                    left={(props) => <List.Icon {...props} icon="account-group" />}
                    right={() =>
                      navigatingGroupId === group.groupId ? (
                        <ActivityIndicator size="small" color={theme.colors.primary} style={{ marginRight: 12, alignSelf: 'center' }} />
                      ) : null
                    }
                    onPress={() => handleGroupPress(group)}
                  />
                </View>
              ))}
            </List.Section>
          </GlassView>
        )}
      </ScrollView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    gap: 16,
  },
  heroCard: {
    alignItems: 'center',
    padding: 24,
    borderRadius: 24,
    gap: 8,
    overflow: 'hidden',
  },
  avatarWrapper: {
    alignSelf: 'center',
    marginBottom: 4,
  },
  heroName: {
    fontWeight: '700',
    marginTop: 12,
    textAlign: 'center',
  },
  heroEmail: {
    textAlign: 'center',
    alignSelf: 'stretch',
    marginTop: 2,
  },
  heroBio: {
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 20,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
  },
  sectionCard: {
    borderRadius: 20,
    overflow: 'hidden',
  },
  noteContainer: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  noteTouchable: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    minHeight: 44,
  },
  noteText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    paddingTop: 2,
  },
  noteEditIcon: {
    margin: 0,
    marginLeft: 4,
  },
  noteInput: {
    fontSize: 14,
    lineHeight: 20,
    minHeight: 60,
    textAlignVertical: 'top',
    paddingTop: 2,
  },
  noteHint: {
    fontSize: 11,
    marginTop: 6,
  },
});
