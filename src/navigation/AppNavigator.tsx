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
    useNavigation,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, View, type ImageSourcePropType } from 'react-native';
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
  // Animated.Value (0=expanded, 1=compact) driven directly by GroupDetailsScreen
  // on the UI thread — morphs the accessory between its expanded and compact states.
  compactAnim: Animated.Value;
};

const GroupTabAccessory = ({ groupId, placement, compactAnim }: GroupTabAccessoryProps) => {
  const navigation = useNavigation<any>();
  const { groups } = useGroups();
  const { ensureGroupThread } = useChat();
  const { theme } = useTheme();

  const group = useMemo(() => groups.find((item) => item.groupId === groupId), [groups, groupId]);

  // Local state controls WHICH layout is rendered (and thus the native bar's height).
  // Flips at compactAnim=0.5 — exactly when both opacity interpolations are at 0,
  // so the height snap is invisible. The spring handles the smooth opacity fade.
  const [isCompact, setIsCompact] = useState(false);
  useEffect(() => {
    const id = compactAnim.addListener(({ value }) => {
      setIsCompact(c => {
        const next = value > 0.5;
        return next !== c ? next : c;
      });
    });
    return () => compactAnim.removeListener(id);
  }, [compactAnim]);

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

  // Opacity interpolations. The 0.1-wide gap between fade-out [0→0.45] and
  // fade-in [0.55→1] ensures both layers are invisible when the local state
  // flips at 0.5, making the height-snap completely invisible.
  const activeOpacity = isCompact
    ? compactAnim.interpolate({ inputRange: [0.55, 1], outputRange: [0, 1], extrapolate: 'clamp' })
    : compactAnim.interpolate({ inputRange: [0, 0.45], outputRange: [1, 0], extrapolate: 'clamp' });
  const slideY = isCompact
    ? compactAnim.interpolate({ inputRange: [0, 1], outputRange: [-4, 0], extrapolate: 'clamp' })
    : compactAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 4], extrapolate: 'clamp' });

  if (placement === 'inline') {
    // Inline placement stays compact — icon-only strip, no backgrounds needed.
    return (
      <View style={styles.groupAccessoryInlineWrap}>
        <View style={styles.groupAccessoryInlineGlass}>
          <TouchableRipple onPress={openSettle} style={styles.groupAccessoryInlineQuick} borderless>
            <View style={styles.groupAccessoryInlineQuickInner}>
              <Icon source="handshake" size={16} color={theme.colors.primary} />
            </View>
          </TouchableRipple>
          <View style={styles.groupAccessoryInlineUtilityCluster}>
            <TouchableRipple onPress={openStats} style={styles.groupAccessoryInlineUtilityButton} borderless>
              <View style={styles.groupAccessoryInlineUtilityButtonInner}>
                <Icon source="chart-pie" size={16} color={theme.colors.primary} />
              </View>
            </TouchableRipple>
            <TouchableRipple onPress={openChat} style={styles.groupAccessoryInlineUtilityButton} borderless>
              <View style={styles.groupAccessoryInlineUtilityButtonInner}>
                <Icon source="chat" size={16} color={theme.colors.primary} />
              </View>
            </TouchableRipple>
            <TouchableRipple onPress={openBills} style={styles.groupAccessoryInlineUtilityButton} borderless>
              <View style={styles.groupAccessoryInlineUtilityButtonInner}>
                <Icon source="repeat" size={16} color={theme.colors.primary} />
              </View>
            </TouchableRipple>
          </View>
          <TouchableRipple onPress={openAddExpense} style={styles.groupAccessoryInlinePrimary} borderless>
            <View style={styles.groupAccessoryInlinePrimaryInner}>
              <Icon source="plus" size={17} color={theme.colors.primary} />
            </View>
          </TouchableRipple>
        </View>
      </View>
    );
  }

  // ── Regular placement: two layouts, only one mounted at a time ──────────────────────────
  // `isCompact` (driven by the compactAnim listener) controls WHICH layout is rendered and
  // therefore the native bar's height. compactAnim drives the opacity fade on whatever is
  // currently rendered. The local state flips at value=0.5 — exactly when both opacity
  // interpolations are 0 — so the height snap is fully hidden by the cross-fade.
  return (
    <Animated.View
      style={[styles.groupAccessoryRegularWrap, { opacity: activeOpacity, transform: [{ translateY: slideY }] }]}
    >
      {isCompact ? (
        // ── Compact: single row of icon+label pills ──────────────────────────
        <View style={styles.groupAccessoryRegularRow}>
          <TouchableRipple onPress={openSettle} style={styles.groupAccessoryPill} borderless>
            <View style={styles.groupAccessoryPillInner}>
              <Icon source="handshake" size={17} color={theme.colors.primary} />
              <Text variant="labelSmall" style={[styles.groupAccessoryPrimaryText, { color: theme.colors.onSurface }]}>Settle</Text>
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
          <TouchableRipple onPress={openAddExpense} style={styles.groupAccessoryPill} borderless>
            <View style={styles.groupAccessoryPillInner}>
              <Icon source="plus" size={17} color={theme.colors.primary} />
              <Text variant="labelSmall" style={[styles.groupAccessoryPrimaryText, { color: theme.colors.onSurface }]}>Add</Text>
            </View>
          </TouchableRipple>
        </View>
      ) : (
        // ── Expanded: two rows, no backgrounds — native liquid glass is the surface ──
        <View style={styles.groupAccessoryExpandedLayout}>
          {/* Row 1: Primary actions */}
          <View style={styles.groupAccessoryExpandedPrimaryRow}>
            <TouchableRipple onPress={openSettle} style={styles.groupAccessoryExpandedPill} borderless>
              <View style={styles.groupAccessoryExpandedPillInner}>
                <Icon source="handshake" size={18} color={theme.colors.primary} />
                <Text style={[styles.groupAccessoryExpandedPillText, { color: theme.colors.onSurface }]}>Settle Up</Text>
              </View>
            </TouchableRipple>
            <TouchableRipple onPress={openAddExpense} style={styles.groupAccessoryExpandedPill} borderless>
              <View style={styles.groupAccessoryExpandedPillInner}>
                <Icon source="plus-circle-outline" size={18} color={theme.colors.primary} />
                <Text style={[styles.groupAccessoryExpandedPillText, { color: theme.colors.onSurface }]}>Add Expense</Text>
              </View>
            </TouchableRipple>
          </View>
          {/* Row 2: Utility actions */}
          <View style={styles.groupAccessoryExpandedUtilityRow}>
            <TouchableRipple onPress={openStats} style={styles.groupAccessoryExpandedUtility} borderless>
              <View style={styles.groupAccessoryExpandedUtilityInner}>
                <Icon source="chart-pie" size={15} color={theme.colors.primary} />
                <Text variant="labelSmall" style={[styles.groupAccessoryExpandedUtilityText, { color: theme.colors.onSurface }]}>Stats</Text>
              </View>
            </TouchableRipple>
            <TouchableRipple onPress={openChat} style={styles.groupAccessoryExpandedUtility} borderless>
              <View style={styles.groupAccessoryExpandedUtilityInner}>
                <Icon source="chat" size={15} color={theme.colors.primary} />
                <Text variant="labelSmall" style={[styles.groupAccessoryExpandedUtilityText, { color: theme.colors.onSurface }]}>Chat</Text>
              </View>
            </TouchableRipple>
            <TouchableRipple onPress={openBills} style={styles.groupAccessoryExpandedUtility} borderless>
              <View style={styles.groupAccessoryExpandedUtilityInner}>
                <Icon source="repeat" size={15} color={theme.colors.primary} />
                <Text variant="labelSmall" style={[styles.groupAccessoryExpandedUtilityText, { color: theme.colors.onSurface }]}>Bills</Text>
              </View>
            </TouchableRipple>
          </View>
        </View>
      )}
    </Animated.View>
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
  const { ensureGroupThread } = useChat();
  // Shared animated value: 0 = expanded, 1 = compact.
  // GroupDetailsScreen springs this directly on the UI thread — the native
  // accessory morphs without any setOptions call or JS state bottleneck.
  const compactAnim = useRef(new Animated.Value(0)).current;

  useLayoutEffect(() => {
    const parent = navigation.getParent();
    if (!parent || !IOS_NATIVE_ACCESSORY_SUPPORTED || !groupId) {
      return;
    }
    // Mount the accessory once. The compactAnim value morphs its content in place.
    parent.setOptions({
      bottomAccessory: ({ placement }: { placement: 'regular' | 'inline' }) => (
        <GroupTabAccessory groupId={groupId} placement={placement} compactAnim={compactAnim} />
      ),
    });
    return () => {
      parent.setOptions({ bottomAccessory: undefined });
    };
  // Only re-run if groupId changes (navigating to a different group).
  // compactAnim is a stable ref — never changes.
  }, [navigation, groupId]);  // eslint-disable-line react-hooks/exhaustive-deps

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
      compactAnim={compactAnim}
    />
  );
};

const GroupsStackNavigator = () => (
  <GroupsStack.Navigator>
    <GroupsStack.Screen name={ROUTES.APP.GROUPS} component={GroupListRoute} options={{ headerShown: false }} />
    <GroupsStack.Screen name={ROUTES.APP.GROUP_DETAILS} component={GroupDetailsRoute} options={{ title: 'Group' }} />
  </GroupsStack.Navigator>
);

const AddExpenseRoute = ({ route, navigation }: any) => {
  const group = useGroupById(route.params.groupId);
  if (!group) {
    return <LoadingScreen />;
  }
  return <AddExpenseScreen group={group} expenseId={route.params.expenseId} onClose={() => navigation.goBack()} />;
};

const SettlementsRoute = ({ route, navigation }: any) => {
  const group = useGroupById(route.params.groupId);
  if (!group) {
    return <LoadingScreen />;
  }
  return (
    <SettlementsScreen
      group={group}
      onClose={() => navigation.goBack()}
      settlementId={route.params.settlementId}
      initialFromUserId={route.params.initialFromUserId}
      initialToUserId={route.params.initialToUserId}
      initialAmount={route.params.initialAmount}
    />
  );
};

const GroupStatsRoute = ({ route }: any) => {
  const group = useGroupById(route.params.groupId);
  if (!group) {
    return <LoadingScreen />;
  }
  return <GroupStatsScreen group={group} />;
};

const RecurringBillsRoute = ({ route }: any) => {
  const group = useGroupById(route.params.groupId);
  if (!group) {
    return <LoadingScreen />;
  }
  return <RecurringBillsScreen group={group} />;
};

const ChatListRoute = ({ navigation }: any) => (
  <ChatListScreen onOpenThread={(thread) => navigation.navigate(ROUTES.APP.GROUP_CHAT, { chatId: thread.chatId })} />
);

const ChatRoomRoute = ({ route }: any) => {
  const { threads } = useChat();
  const thread = threads.find((item) => item.chatId === route.params.chatId);

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

const AuthStackNavigator = () => (
  <AuthStack.Navigator screenOptions={{ headerShown: false }}>
    <AuthStack.Screen name={ROUTES.AUTH.SIGN_IN} component={SignInRoute} />
    <AuthStack.Screen name={ROUTES.AUTH.REGISTER} component={RegisterRoute} />
    <AuthStack.Screen name={ROUTES.AUTH.FORGOT_PASSWORD} component={ForgotPasswordRoute} />
  </AuthStack.Navigator>
);

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
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: isDark ? '#9CA3AF' : '#64748B',
        tabBarLabelStyle: {
          fontWeight: '600',
          fontSize: 12,
        },
        tabBarStyle: Platform.select({
          android: {
            backgroundColor: isDark ? '#0D1117' : '#FFFFFF',
          },
          default: undefined,
        }),
        tabBarActiveIndicatorColor: Platform.select({
          android: isDark ? 'rgba(88,166,255,0.20)' : 'rgba(31,111,235,0.16)',
          default: undefined,
        }),
        tabBarBlurEffect: Platform.OS === 'ios' ? 'systemDefault' : undefined,
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
  const { theme } = useTheme();

  return (
      <AppStack.Navigator>
      <AppStack.Screen name={ROUTES.APP.ROOT} component={AppTabs} options={{ headerShown: false }} />
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
        options={{ title: 'Group Stats' }}
      />
      <AppStack.Screen
        name={ROUTES.APP.RECURRING_BILLS}
        component={RecurringBillsRoute}
        options={{ title: 'Recurring Bills' }}
      />
      <AppStack.Screen
        name={ROUTES.APP.CALL_INFO}
        component={CallInfoRoute}
        options={{
          title: '',
          headerTransparent: true,
          headerTintColor: theme.colors.primary,
        }}
      />
      <AppStack.Screen
        name={ROUTES.APP.CALL_DETAIL}
        component={CallSessionRoute}
        options={{ title: 'Live call' }}
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
  // Regular morphing wrapper — height is determined by whichever layout is rendered.
  groupAccessoryRegularWrap: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  // Expanded layout container (in normal flow, 2 rows)
  groupAccessoryExpandedLayout: {
    gap: 6,
  },
  groupAccessoryExpandedPrimaryRow: {
    flexDirection: 'row',
    gap: 10,
  },
  groupAccessoryExpandedPill: {
    flex: 1,
    borderRadius: 50,
    overflow: 'hidden',
  },
  groupAccessoryExpandedPillInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  groupAccessoryExpandedPillText: {
    fontWeight: '700',
    fontSize: 14,
    lineHeight: 17,
  },
  groupAccessoryExpandedUtilityRow: {
    flexDirection: 'row',
    gap: 6,
  },
  groupAccessoryExpandedUtility: {
    flex: 1,
    borderRadius: 50,
    overflow: 'hidden',
  },
  groupAccessoryExpandedUtilityInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 9,
    paddingHorizontal: 8,
  },
  groupAccessoryExpandedUtilityText: {
    fontWeight: '600',
    fontSize: 12,
    lineHeight: 14,
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
    minWidth: 80,
  },
  groupAccessoryPrimaryText: {
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

  const navigationTheme = {
    ...(isDark ? DarkTheme : DefaultTheme),
    colors: {
      ...(isDark ? DarkTheme.colors : DefaultTheme.colors),
      background: 'transparent',
      card: 'transparent',
      border: 'transparent',
    },
  };

  return (
    <NavigationContainer theme={navigationTheme}>
      <View style={{ flex: 1 }}>
        {user ? <AppStackNavigator /> : <AuthStackNavigator />}
        {user && <IncomingCallHandler />}
      </View>
    </NavigationContainer>
  );
};

export default AppNavigator;
