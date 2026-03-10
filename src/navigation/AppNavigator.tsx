import { IncomingCallModal } from '@/components/IncomingCallModal';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useCallContext } from '@/context/CallContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { CallType, Group, PresenceStatus } from '@/models';
import { ForgotPasswordScreen } from '@/screens/auth/ForgotPasswordScreen';
import { RegisterScreen } from '@/screens/auth/RegisterScreen';
import { SignInScreen } from '@/screens/auth/SignInScreen';
import { CallHistoryScreen } from '@/screens/calls/CallHistoryScreen';
import { CallInfoScreen } from '@/screens/calls/CallInfoScreen';
import { CallSessionScreen } from '@/screens/calls/CallSessionScreen';
import { ChatListScreen } from '@/screens/chat/ChatListScreen';
import { ChatRoomScreen } from '@/screens/chat/ChatRoomScreen';
import { MessageInfoScreen } from '@/screens/chat/MessageInfoScreen';
import { AddExpenseScreen } from '@/screens/expenses/AddExpenseScreen';
import { ExpenseDetailsScreen } from '@/screens/expenses/ExpenseDetailsScreen';
import { RecurringBillsScreen } from '@/screens/expenses/RecurringBillsScreen';
import { SettlementsScreen } from '@/screens/expenses/SettlementsScreen';
import { GroupDetailsScreen } from '@/screens/groups/GroupDetailsScreen';
import { GroupInfoScreen } from '@/screens/groups/GroupInfoScreen';
import { GroupListScreen } from '@/screens/groups/GroupListScreen';
import { GroupStatsScreen } from '@/screens/groups/GroupStatsScreen';
import { LoadingScreen } from '@/screens/onboarding/LoadingScreen';
import { SettingsScreen } from '@/screens/settings/SettingsScreen';
import { lightHaptic } from '@/utils/haptics';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { NativeBottomTabIcon } from '@react-navigation/bottom-tabs/unstable';
import {
    DarkTheme,
    DefaultTheme,
    NavigationContainer,
    useIsFocused,
    useNavigation,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, TouchableOpacity, View, type ImageSourcePropType } from 'react-native';
import { Icon, Text, TouchableRipple } from 'react-native-paper';

import { AppStack, AuthStack, NativeTab } from './stacks';

type GroupWithFallback = Group | undefined;
type TabIconKey = 'groups' | 'chat' | 'calls' | 'settings';

type NativeIconPair = {
  active?: ImageSourcePropType;
  inactive?: ImageSourcePropType;
};

type NativeIconMap = Record<TabIconKey, NativeIconPair>;

const EMPTY_NATIVE_ICON_MAP: NativeIconMap = {
  groups: {},
  chat: {},
  calls: {},
  settings: {},
};
const FALLBACK_NATIVE_TAB_ICON = {
  type: 'image',
  source: require('../../assets/icon.png'),
} as const;
const GroupsStack = createNativeStackNavigator();

const IOS_NATIVE_ACCESSORY_SUPPORTED =
  Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26;

const useGroupById = (groupId: string): GroupWithFallback => {
  const { groups } = useGroups();
  return useMemo(() => groups.find((group) => group.groupId === groupId), [groups, groupId]);
};

type GroupTabAccessoryProps = {
  groupId: string;
  placement: 'regular' | 'inline';
};

const GroupTabAccessory = ({ groupId, placement }: GroupTabAccessoryProps) => {
  const navigation = useNavigation<any>();
  const { groups } = useGroups();
  const { ensureGroupThread } = useChat();
  const { theme } = useTheme();

  const group = useMemo(() => groups.find((item) => item.groupId === groupId), [groups, groupId]);

  if (!group) {
    return null;
  }

  const openStats = () => {
    lightHaptic();
    navigation.navigate(ROUTES.APP.GROUP_STATS, { groupId: group.groupId });
  };

  const openBills = () => {
    lightHaptic();
    navigation.navigate(ROUTES.APP.RECURRING_BILLS, { groupId: group.groupId });
  };

  const openAddExpense = () => {
    lightHaptic();
    navigation.navigate(ROUTES.APP.ADD_EXPENSE, { groupId: group.groupId });
  };

  const openSettle = () => {
    lightHaptic();
    navigation.navigate(ROUTES.APP.SETTLEMENTS, { groupId: group.groupId });
  };

  const openChat = async () => {
    lightHaptic();
    try {
      const participants = group.members.map((member) => ({
        userId: member.userId,
        displayName: member.displayName,
        photoURL: member.photoURL,
        status: 'online' as PresenceStatus,
      }));
      const chatId = await ensureGroupThread(group.groupId, participants);
      navigation.navigate(ROUTES.APP.GROUP_CHAT, { chatId });
    } catch (error) {
      console.error('Unable to open chat', error);
    }
  };

  if (placement === 'inline') {
    return (
      <View style={styles.groupAccessoryInlineWrap}>
        <View style={styles.groupAccessoryInlineGlass}>
          <TouchableOpacity onPress={openSettle} style={[styles.groupAccessoryInlineQuick, { backgroundColor: '#10b981' }]} activeOpacity={0.85}>
            <View style={styles.groupAccessoryInlineQuickInner}>
              <Icon source="handshake" size={16} color="#fff" />
            </View>
          </TouchableOpacity>

          <View style={styles.groupAccessoryInlineUtilityCluster}>
            <TouchableOpacity onPress={openStats} style={styles.groupAccessoryInlineUtilityButton} activeOpacity={0.85}>
              <View style={styles.groupAccessoryInlineUtilityButtonInner}>
                <Icon source="chart-pie" size={16} color={theme.colors.primary} />
              </View>
            </TouchableOpacity>
            <TouchableOpacity onPress={openChat} style={styles.groupAccessoryInlineUtilityButton} activeOpacity={0.85}>
              <View style={styles.groupAccessoryInlineUtilityButtonInner}>
                <Icon source="chat" size={16} color={theme.colors.primary} />
              </View>
            </TouchableOpacity>
            <TouchableOpacity onPress={openBills} style={styles.groupAccessoryInlineUtilityButton} activeOpacity={0.85}>
              <View style={styles.groupAccessoryInlineUtilityButtonInner}>
                <Icon source="repeat" size={16} color={theme.colors.primary} />
              </View>
            </TouchableOpacity>
          </View>

          <TouchableOpacity onPress={openAddExpense} style={[styles.groupAccessoryInlinePrimary, { backgroundColor: theme.colors.primary }]} activeOpacity={0.85}>
            <View style={styles.groupAccessoryInlinePrimaryInner}>
              <Icon source="plus" size={17} color="#fff" />
            </View>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.groupAccessoryRegularWrap}>
      <View style={styles.groupAccessoryRegularGlass}>
        <View style={styles.groupAccessoryRegularRow}>
          <TouchableRipple onPress={openSettle} style={[styles.groupAccessoryPill, { backgroundColor: '#10b981' }]} borderless>
            <View style={styles.groupAccessoryPillInner}>
              <Icon source="handshake" size={17} color="#fff" />
              <Text variant="labelSmall" style={styles.groupAccessoryPrimaryText}>Settle</Text>
            </View>
          </TouchableRipple>
          <View style={styles.groupAccessoryUtilityCluster}>
            <TouchableRipple onPress={openStats} style={styles.groupAccessoryUtilityButton} borderless>
              <View style={styles.groupAccessoryUtilityButtonInner}>
                <Icon source="chart-pie" size={17} color={theme.colors.primary} />
                <Text variant="labelSmall" style={[styles.groupAccessoryUtilityText, { color: theme.colors.onSurface }]}>Stats</Text>
              </View>
            </TouchableRipple>
            <TouchableRipple onPress={openChat} style={styles.groupAccessoryUtilityButton} borderless>
              <View style={styles.groupAccessoryUtilityButtonInner}>
                <Icon source="chat" size={17} color={theme.colors.primary} />
                <Text variant="labelSmall" style={[styles.groupAccessoryUtilityText, { color: theme.colors.onSurface }]}>Chat</Text>
              </View>
            </TouchableRipple>
            <TouchableRipple onPress={openBills} style={styles.groupAccessoryUtilityButton} borderless>
              <View style={styles.groupAccessoryUtilityButtonInner}>
                <Icon source="repeat" size={17} color={theme.colors.primary} />
                <Text variant="labelSmall" style={[styles.groupAccessoryUtilityText, { color: theme.colors.onSurface }]}>Bills</Text>
              </View>
            </TouchableRipple>
          </View>
          <TouchableRipple onPress={openAddExpense} style={[styles.groupAccessoryPill, { backgroundColor: theme.colors.primary }]} borderless>
            <View style={styles.groupAccessoryPillInner}>
              <Icon source="plus" size={17} color="#fff" />
              <Text variant="labelSmall" style={styles.groupAccessoryPrimaryText}>Add</Text>
            </View>
          </TouchableRipple>
        </View>
      </View>
    </View>
  );
};

const SignInRoute = ({ navigation }: any) => (
  <SignInScreen
    onSwitchToRegister={() => navigation.navigate(ROUTES.AUTH.REGISTER)}
    onForgotPassword={() => navigation.navigate(ROUTES.AUTH.FORGOT_PASSWORD)}
  />
);

const RegisterRoute = ({ navigation }: any) => (
  <RegisterScreen onSwitchToSignIn={() => navigation.navigate(ROUTES.AUTH.SIGN_IN)} />
);

const ForgotPasswordRoute = ({ navigation }: any) => (
  <ForgotPasswordScreen onBack={() => navigation.goBack()} />
);

const GroupListRoute = ({ navigation }: any) => (
  <GroupListScreen onOpenGroup={(group) => navigation.navigate(ROUTES.APP.GROUP_DETAILS, { groupId: group.groupId })} />
);

const GroupDetailsRoute = ({ route, navigation }: any) => {
  const group = useGroupById(route.params.groupId);
  const groupId = group?.groupId;
  const isFocused = useIsFocused();
  const { ensureGroupThread } = useChat();
  const [showAccessory, setShowAccessory] = useState(false);
  const accessoryVisibleRef = useRef<boolean | null>(null);

  useLayoutEffect(() => {
    if (group) {
      navigation.setOptions({ title: group.name });
    }
  }, [navigation, group?.name]);

  useLayoutEffect(() => {
    const parent = navigation.getParent();
    if (!parent || !IOS_NATIVE_ACCESSORY_SUPPORTED) {
      return;
    }

    const shouldShowAccessory = Boolean(groupId && showAccessory && isFocused);
    if (accessoryVisibleRef.current === shouldShowAccessory) {
      return;
    }

    accessoryVisibleRef.current = shouldShowAccessory;
    if (shouldShowAccessory) {
      parent.setOptions({
        bottomAccessory: ({ placement }: { placement: 'regular' | 'inline' }) => (
          <GroupTabAccessory groupId={groupId!} placement={placement} />
        ),
      });
    } else {
      parent.setOptions({ bottomAccessory: undefined });
    }

    return () => {
      parent.setOptions({ bottomAccessory: undefined });
      accessoryVisibleRef.current = null;
    };
  }, [navigation, groupId, showAccessory, isFocused]);

  if (!group) {
    return <LoadingScreen />;
  }
  const handleOpenChat = async () => {
    try {
      const participants = group.members.map((member) => ({
        userId: member.userId,
        displayName: member.displayName,
        photoURL: member.photoURL,
        status: 'online' as PresenceStatus,
      }));
      const chatId = await ensureGroupThread(group.groupId, participants);
      navigation.navigate(ROUTES.APP.GROUP_CHAT, { chatId });
    } catch (error) {
      console.error('Unable to open chat', error);
    }
  };
  return (
    <GroupDetailsScreen
      group={group}
      onAddExpense={() => navigation.navigate(ROUTES.APP.ADD_EXPENSE, { groupId: group.groupId })}
      onSettle={() => navigation.navigate(ROUTES.APP.SETTLEMENTS, { groupId: group.groupId })}
      onOpenChat={handleOpenChat}
      onCompactModeChange={setShowAccessory}
    />
  );
};

const GroupsStackNavigator = () => {
  const { isDark } = useTheme();
  const screenBackground = isDark ? '#121212' : '#FDFBFB';

  return (
    <GroupsStack.Navigator
      screenOptions={{
        contentStyle: { backgroundColor: screenBackground },
      }}
    >
      <GroupsStack.Screen name={ROUTES.APP.GROUPS} component={GroupListRoute} options={{ headerShown: false }} />
      <GroupsStack.Screen name={ROUTES.APP.GROUP_DETAILS} component={GroupDetailsRoute} options={{ title: 'Group' }} />
    </GroupsStack.Navigator>
  );
};

const AddExpenseRoute = ({ route, navigation }: any) => {
  const group = useGroupById(route.params.groupId);
  if (!group) {
    return <LoadingScreen />;
  }

  const handleClose = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }

    // Fallback when AddExpense is opened as an entry route without history.
    navigation.navigate(ROUTES.APP.ROOT, {
      screen: ROUTES.APP.GROUPS_TAB,
      params: {
        screen: ROUTES.APP.GROUP_DETAILS,
        params: { groupId: group.groupId },
      },
    });
  };

  return <AddExpenseScreen group={group} expenseId={route.params.expenseId} onClose={handleClose} />;
};

const SettlementsRoute = ({ route, navigation }: any) => {
  const group = useGroupById(route.params.groupId);
  if (!group) {
    return <LoadingScreen />;
  }

  const handleClose = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }

    navigation.navigate(ROUTES.APP.ROOT, {
      screen: ROUTES.APP.GROUPS_TAB,
      params: {
        screen: ROUTES.APP.GROUP_DETAILS,
        params: { groupId: group.groupId },
      },
    });
  };

  return (
    <SettlementsScreen
      group={group}
      onClose={handleClose}
      settlementId={route.params.settlementId}
      initialFromUserId={route.params.initialFromUserId}
      initialToUserId={route.params.initialToUserId}
      initialAmount={route.params.initialAmount}
    />
  );
};

const GroupStatsRoute = ({ route, navigation }: any) => {
  const group = useGroupById(route.params.groupId);

  useLayoutEffect(() => {
    if (group) {
      navigation.setOptions({ headerBackTitle: group.name });
    }
  }, [navigation, group?.name]);

  if (!group) {
    return <LoadingScreen />;
  }
  return <GroupStatsScreen group={group} />;
};

const RecurringBillsRoute = ({ route, navigation }: any) => {
  const group = useGroupById(route.params.groupId);

  useLayoutEffect(() => {
    if (group) {
      navigation.setOptions({ headerBackTitle: group.name });
    }
  }, [navigation, group?.name]);

  if (!group) {
    return <LoadingScreen />;
  }
  return <RecurringBillsScreen group={group} />;
};

const ChatListRoute = ({ navigation }: any) => (
  <ChatListScreen onOpenThread={(thread) => navigation.navigate(ROUTES.APP.GROUP_CHAT, { chatId: thread.chatId })} />
);

const ChatRoomRoute = ({ route, navigation }: any) => {
  const { threads } = useChat();
  const { groups } = useGroups();
  const { user } = useAuth();
  const thread = threads.find((item) => item.chatId === route.params.chatId);

  const chatTitle = useMemo(() => {
    if (!thread) return '';
    if (thread.type === 'group' && thread.groupId) {
      const grp = groups.find((g) => g.groupId === thread.groupId);
      return grp?.name || 'Group Chat';
    }
    const other = thread.participants.find((p) => p.userId !== user?.userId) ?? thread.participants[0];
    return other?.displayName || 'Chat';
  }, [thread, groups, user?.userId]);

  useLayoutEffect(() => {
    if (chatTitle) {
      navigation.setOptions({ headerBackTitle: chatTitle });
    }
  }, [navigation, chatTitle]);

  if (!thread) {
    return <LoadingScreen />;
  }

  return <ChatRoomScreen thread={thread} />;
};

const CallHistoryRoute = ({ navigation }: any) => (
  <CallHistoryScreen
    onStartCall={(thread, type) =>
      navigation.navigate(ROUTES.APP.CALL_DETAIL, {
        chatId: thread.chatId,
        groupId: thread.groupId,
        type,
      })
    }
    onOpenCallInfo={(entry) =>
      navigation.navigate(ROUTES.APP.CALL_INFO, { entry })
    }
  />
);

const CallInfoRoute = ({ route, navigation }: any) => (
  <CallInfoScreen
    entry={route.params.entry}
    onCallBack={(thread, type) =>
      navigation.navigate(ROUTES.APP.CALL_DETAIL, {
        chatId: thread.chatId,
        groupId: thread.groupId,
        type,
      })
    }
  />
);

const CallSessionRoute = ({ route, navigation }: any) => (
  <CallSessionScreen
    chatId={route.params.chatId}
    groupId={route.params.groupId}
    type={route.params.type as CallType}
    joinCallId={route.params.joinCallId}
    onHangUp={() => {
      if (typeof navigation.canGoBack === 'function' && navigation.canGoBack()) {
        navigation.goBack();
        return;
      }
      navigation.navigate(ROUTES.APP.ROOT, { screen: ROUTES.APP.CALLS_TAB });
    }}
  />
);

const AuthStackNavigator = () => {
  const { isDark } = useTheme();
  const screenBackground = isDark ? '#121212' : '#FDFBFB';

  return (
    <AuthStack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: screenBackground },
      }}
    >
      <AuthStack.Screen name={ROUTES.AUTH.SIGN_IN} component={SignInRoute} />
      <AuthStack.Screen name={ROUTES.AUTH.REGISTER} component={RegisterRoute} />
      <AuthStack.Screen name={ROUTES.AUTH.FORGOT_PASSWORD} component={ForgotPasswordRoute} />
    </AuthStack.Navigator>
  );
};

const AppTabs = () => {
  const { theme, isDark } = useTheme();
  const [androidIcons, setAndroidIcons] = useState<NativeIconMap>(EMPTY_NATIVE_ICON_MAP);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }

    let isActive = true;
    const inactiveColor = isDark ? '#9CA3AF' : '#64748B';
    const activeColor = theme.colors.primary;

    const loadIcon = async (name: React.ComponentProps<typeof MaterialCommunityIcons>['name'], color: string) => {
      const source = await MaterialCommunityIcons.getImageSource(name, 24, color);
      return source ?? undefined;
    };

    const loadAndroidIcons = async () => {
      try {
        const [
          groupsInactive,
          groupsActive,
          chatInactive,
          chatActive,
          callsInactive,
          callsActive,
          settingsInactive,
          settingsActive,
        ] = await Promise.all([
          loadIcon('account-group-outline', inactiveColor),
          loadIcon('account-group', activeColor),
          loadIcon('chat-processing-outline', inactiveColor),
          loadIcon('chat-processing', activeColor),
          loadIcon('phone-outline', inactiveColor),
          loadIcon('phone', activeColor),
          loadIcon('cog-outline', inactiveColor),
          loadIcon('cog', activeColor),
        ]);

        if (!isActive) {
          return;
        }

        setAndroidIcons({
          groups: { inactive: groupsInactive, active: groupsActive ?? groupsInactive },
          chat: { inactive: chatInactive, active: chatActive ?? chatInactive },
          calls: { inactive: callsInactive, active: callsActive ?? callsInactive },
          settings: { inactive: settingsInactive, active: settingsActive ?? settingsInactive },
        });
      } catch (error) {
        console.warn('⚠️ Failed to load native tab icons, falling back to labels.', error);
      }
    };

    void loadAndroidIcons();
    return () => {
      isActive = false;
    };
  }, [isDark, theme.colors.primary]);

  const getTabIcon = (key: TabIconKey, focused: boolean): NativeBottomTabIcon => {
    if (Platform.OS === 'ios') {
      const iosIconMap: Record<TabIconKey, { regular: string; filled: string }> = {
        groups: { regular: 'person.3', filled: 'person.3.fill' },
        chat: { regular: 'bubble.left.and.bubble.right', filled: 'bubble.left.and.bubble.right.fill' },
        calls: { regular: 'phone', filled: 'phone.fill' },
        settings: { regular: 'gearshape', filled: 'gearshape.fill' },
      };

      const icon = iosIconMap[key];
      return { type: 'sfSymbol', name: focused ? icon.filled : icon.regular } as NativeBottomTabIcon;
    }

    const source = focused
      ? (androidIcons[key].active ?? androidIcons[key].inactive)
      : (androidIcons[key].inactive ?? androidIcons[key].active);

    if (!source) {
      return FALLBACK_NATIVE_TAB_ICON as NativeBottomTabIcon;
    }

    return { type: 'image', source } as NativeBottomTabIcon;
  };

  return (
    <NativeTab.Navigator
      screenOptions={{
        headerShown: false,
        lazy: Platform.OS === 'ios' ? false : true,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: isDark ? '#9CA3AF' : '#64748B',
        tabBarLabelStyle: {
          fontWeight: '600',
          fontSize: 12,
        },
        tabBarStyle: Platform.select({
          ios: {
            backgroundColor: isDark ? '#121212' : '#FDFBFB',
          },
          android: {
            backgroundColor: isDark ? '#0D1117' : '#FFFFFF',
          },
          default: undefined,
        }),
        tabBarActiveIndicatorColor: Platform.select({
          android: isDark ? 'rgba(88,166,255,0.20)' : 'rgba(31,111,235,0.16)',
          default: undefined,
        }),
        tabBarBlurEffect: Platform.OS === 'ios' ? (isDark ? 'systemMaterialDark' : 'systemMaterialLight') : undefined,
        tabBarControllerMode: Platform.OS === 'ios' ? 'tabBar' : undefined,
        tabBarMinimizeBehavior: IOS_NATIVE_ACCESSORY_SUPPORTED ? 'onScrollDown' : undefined,
      }}
    >
      <NativeTab.Screen
        name={ROUTES.APP.GROUPS_TAB}
        component={GroupsStackNavigator}
        options={{
          title: 'Groups',
          tabBarLabel: 'Groups',
          tabBarIcon: ({ focused }: { focused: boolean }) => getTabIcon('groups', focused),
        }}
      />
      <NativeTab.Screen
        name={ROUTES.APP.CHAT_TAB}
        component={ChatListRoute}
        options={{
          title: 'Chat',
          tabBarLabel: 'Chat',
          tabBarIcon: ({ focused }) => getTabIcon('chat', focused),
        }}
      />
      <NativeTab.Screen
        name={ROUTES.APP.CALLS_TAB}
        component={CallHistoryRoute}
        options={{
          title: 'Calls',
          tabBarLabel: 'Calls',
          tabBarIcon: ({ focused }) => getTabIcon('calls', focused),
        }}
      />
      <NativeTab.Screen
        name={ROUTES.APP.SETTINGS}
        component={SettingsScreen}
        options={{
          title: 'Settings',
          tabBarLabel: 'Settings',
          tabBarIcon: ({ focused }) => getTabIcon('settings', focused),
        }}
      />
    </NativeTab.Navigator>
  );
};

const AppStackNavigator = () => {
  const { theme, isDark } = useTheme();
  const screenBackground = isDark ? '#121212' : '#FDFBFB';

  return (
      <AppStack.Navigator
        screenOptions={{
          contentStyle: { backgroundColor: screenBackground },
        }}
      >
      <AppStack.Screen name={ROUTES.APP.ROOT} component={AppTabs} options={{ headerShown: false, title: 'Home' }} />
      <AppStack.Screen
        name={ROUTES.APP.GROUP_INFO}
        component={GroupInfoScreen}
        options={{
          title: '',
          headerTransparent: true,
          headerTintColor: theme.colors.primary,
        }}
      />
      <AppStack.Screen
        name={ROUTES.APP.GROUP_CHAT}
        component={ChatRoomRoute}
        options={{
          title: '',
          headerTransparent: true,
          headerTintColor: theme.colors.primary,
        }}
      />
      <AppStack.Screen
        name={ROUTES.APP.MESSAGE_INFO}
        component={MessageInfoScreen}
        options={{
          title: '',
          headerBackTitle: 'Chat',
          headerTransparent: true,
          headerTintColor: theme.colors.primary,
        }}
      />
      <AppStack.Screen
        name={ROUTES.APP.ADD_EXPENSE}
        component={AddExpenseRoute}
        options={{ presentation: 'modal', headerShown: false }}
      />
      <AppStack.Screen
        name={ROUTES.APP.SETTLEMENTS}
        component={SettlementsRoute}
        options={{ presentation: 'modal', headerShown: false }}
      />
      <AppStack.Screen
        name={ROUTES.APP.EXPENSE_DETAILS}
        component={ExpenseDetailsScreen}
        options={{ title: 'Expense Details' }}
      />
      <AppStack.Screen
        name={ROUTES.APP.GROUP_STATS}
        component={GroupStatsRoute}
        options={{ title: 'Group Stats', headerBackTitle: 'Group' }}
      />
      <AppStack.Screen
        name={ROUTES.APP.RECURRING_BILLS}
        component={RecurringBillsRoute}
        options={{ title: 'Recurring Bills', headerBackTitle: 'Group' }}
      />
      <AppStack.Screen
        name={ROUTES.APP.CALL_INFO}
        component={CallInfoRoute}
        options={{
          title: '',
          headerBackTitle: 'Calls',
          headerTransparent: true,
          headerTintColor: theme.colors.primary,
        }}
      />
      <AppStack.Screen
        name={ROUTES.APP.CALL_DETAIL}
        component={CallSessionRoute}
        options={{ title: 'Live call', headerBackTitle: 'Calls' }}
      />
    </AppStack.Navigator>
  );
};

// Incoming call handler - must be inside NavigationContainer
const IncomingCallHandler = () => {
  const { incomingCall, dismissIncomingCall, acceptCall } = useCallContext();
  const navigation = useNavigation<any>();

  const handleAccept = () => {
    const call = acceptCall();
    if (call) {
      navigation.navigate(ROUTES.APP.CALL_DETAIL, {
        chatId: call.chatId,
        groupId: call.groupId,
        type: call.type,
        joinCallId: call.callId,
      });
    }
  };

  return (
    <IncomingCallModal
      visible={!!incomingCall}
      callerName={incomingCall?.initiatorName || 'Unknown'}
      callType={incomingCall?.type || 'audio'}
      onAccept={handleAccept}
      onDecline={dismissIncomingCall}
    />
  );
};

const styles = StyleSheet.create({
  navigatorRoot: {
    flex: 1,
  },
  groupAccessoryRegularWrap: {
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 4,
  },
  groupAccessoryRegularGlass: {
    borderRadius: 50,
    paddingHorizontal: 0,
    paddingVertical: 0,
    backgroundColor: 'transparent',
  },
  groupAccessoryRegularRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  groupAccessoryUtilityCluster: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 50,
    paddingHorizontal: 0,
    paddingVertical: 0,
    gap: 4,
    backgroundColor: 'transparent',
  },
  groupAccessoryUtilityButton: {
    flex: 1,
    borderRadius: 50,
    overflow: 'hidden',
  },
  groupAccessoryUtilityButtonInner: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    gap: 2,
  },
  groupAccessoryUtilityText: {
    fontWeight: '600',
    fontSize: 11,
    lineHeight: 13,
  },
  groupAccessoryPill: {
    borderRadius: 50,
    overflow: 'hidden',
  },
  groupAccessoryPillInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 14,
    minWidth: 90,
  },
  groupAccessoryPrimaryText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
    lineHeight: 16,
  },
  groupAccessoryInlineWrap: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  groupAccessoryInlineGlass: {
    borderRadius: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: 'transparent',
  },
  groupAccessoryInlineUtilityCluster: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 50,
    paddingHorizontal: 5,
    paddingVertical: 4,
    gap: 3,
    backgroundColor: 'transparent',
  },
  groupAccessoryInlineUtilityButton: {
    flex: 1,
    borderRadius: 50,
    overflow: 'hidden',
  },
  groupAccessoryInlineUtilityButtonInner: {
    width: 34,
    height: 34,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupAccessoryInlinePrimary: {
    minWidth: 52,
    borderRadius: 50,
    overflow: 'hidden',
  },
  groupAccessoryInlinePrimaryInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  groupAccessoryInlineQuick: {
    borderRadius: 50,
    overflow: 'hidden',
  },
  groupAccessoryInlineQuickInner: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export const AppNavigator = () => {
  const { user, loading } = useAuth();
  const { isDark } = useTheme();

  if (loading) {
    return <LoadingScreen />;
  }

  const navigationBackground = isDark ? '#121212' : '#FDFBFB';

  const navigationTheme = {
    ...(isDark ? DarkTheme : DefaultTheme),
    colors: {
      ...(isDark ? DarkTheme.colors : DefaultTheme.colors),
      background: navigationBackground,
      card: navigationBackground,
      border: 'transparent',
    },
  };

  return (
    <NavigationContainer theme={navigationTheme}>
      <View style={[styles.navigatorRoot, { backgroundColor: navigationBackground }]}>
        {user ? <AppStackNavigator /> : <AuthStackNavigator />}
        {user && <IncomingCallHandler />}
      </View>
    </NavigationContainer>
  );
};

export default AppNavigator;
