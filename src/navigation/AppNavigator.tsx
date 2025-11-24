import { GlassTabBar } from '@/components/GlassTabBar';
import { colors, ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import type { CallType, Group, PresenceStatus } from '@/models';
import { ForgotPasswordScreen } from '@/screens/auth/ForgotPasswordScreen';
import { RegisterScreen } from '@/screens/auth/RegisterScreen';
import { SignInScreen } from '@/screens/auth/SignInScreen';
import { CallLobbyScreen } from '@/screens/calls/CallLobbyScreen';
import { CallSessionScreen } from '@/screens/calls/CallSessionScreen';
import { ChatListScreen } from '@/screens/chat/ChatListScreen';
import { ChatRoomScreen } from '@/screens/chat/ChatRoomScreen';
import { AddExpenseScreen } from '@/screens/expenses/AddExpenseScreen';
import { ExpenseDetailsScreen } from '@/screens/expenses/ExpenseDetailsScreen';
import { SettlementsScreen } from '@/screens/expenses/SettlementsScreen';
import { GroupDetailsScreen } from '@/screens/groups/GroupDetailsScreen';
import { GroupListScreen } from '@/screens/groups/GroupListScreen';
import { GroupStatsScreen } from '@/screens/groups/GroupStatsScreen';
import { LoadingScreen } from '@/screens/onboarding/LoadingScreen';
import { SettingsScreen } from '@/screens/settings/SettingsScreen';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { getFocusedRouteNameFromRoute, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useMemo } from 'react';

const AuthStack = createNativeStackNavigator();
const GroupStack = createNativeStackNavigator();
const ChatStack = createNativeStackNavigator();
const CallStack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

type GroupWithFallback = Group | undefined;

const useGroupById = (groupId: string): GroupWithFallback => {
  const { groups } = useGroups();
  return useMemo(() => groups.find((group) => group.groupId === groupId), [groups, groupId]);
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

const ForgotPasswordRoute = ({ navigation }: any) => <ForgotPasswordScreen onBack={() => navigation.goBack()} />;

const GroupListRoute = ({ navigation }: any) => (
  <GroupListScreen onOpenGroup={(group) => navigation.navigate(ROUTES.APP.GROUP_DETAILS, { groupId: group.groupId })} />
);

const GroupDetailsRoute = ({ route, navigation }: any) => {
  const group = useGroupById(route.params.groupId);
  const { ensureGroupThread } = useChat();
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
    />
  );
};

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
  return <SettlementsScreen group={group} onClose={() => navigation.goBack()} />;
};

const GroupStatsRoute = ({ route, navigation }: any) => {
  const group = useGroupById(route.params.groupId);
  if (!group) {
    return <LoadingScreen />;
  }
  return <GroupStatsScreen group={group} />;
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

const CallLobbyRoute = ({ navigation }: any) => (
  <CallLobbyScreen
    onStartCall={(thread, type) =>
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
    onHangUp={() => navigation.goBack()}
  />
);

const AuthStackNavigator = () => (
  <AuthStack.Navigator screenOptions={{ headerShown: false }}>
    <AuthStack.Screen name={ROUTES.AUTH.SIGN_IN} component={SignInRoute} />
    <AuthStack.Screen name={ROUTES.AUTH.REGISTER} component={RegisterRoute} />
    <AuthStack.Screen name={ROUTES.AUTH.FORGOT_PASSWORD} component={ForgotPasswordRoute} />
  </AuthStack.Navigator>
);

const GroupStackNavigator = () => (
  <GroupStack.Navigator>
    <GroupStack.Screen name={ROUTES.APP.GROUPS} component={GroupListRoute} options={{ title: 'Groups' }} />
    <GroupStack.Screen name={ROUTES.APP.GROUP_DETAILS} component={GroupDetailsRoute} options={{ title: 'Group' }} />
    <GroupStack.Screen
      name={ROUTES.APP.ADD_EXPENSE}
      component={AddExpenseRoute}
      options={{ presentation: 'modal', headerShown: false }}
    />
    <GroupStack.Screen
      name={ROUTES.APP.EXPENSE_DETAILS}
      component={ExpenseDetailsScreen}
      options={{ title: 'Expense Details' }}
    />
    <GroupStack.Screen
      name={ROUTES.APP.SETTLEMENTS}
      component={SettlementsRoute}
      options={{ presentation: 'modal', headerShown: false }}
    />
    <GroupStack.Screen name={ROUTES.APP.GROUP_STATS} component={GroupStatsRoute} options={{ title: 'Group Stats' }} />
    <GroupStack.Screen
      name={ROUTES.APP.GROUP_CHAT}
      component={ChatRoomRoute}
      options={{
        title: '',
        headerTransparent: true,
        headerTintColor: colors.primary,
      }}
    />
  </GroupStack.Navigator>
);

const ChatStackNavigator = () => (
  <ChatStack.Navigator>
    <ChatStack.Screen name={ROUTES.APP.CHAT} component={ChatListRoute} options={{ title: 'Chats' }} />
    <ChatStack.Screen
      name={ROUTES.APP.GROUP_CHAT}
      component={ChatRoomRoute}
      options={{
        title: '',
        headerTransparent: true,
        headerTintColor: colors.primary,
      }}
    />
  </ChatStack.Navigator>
);

const CallStackNavigator = () => (
  <CallStack.Navigator>
    <CallStack.Screen name={ROUTES.APP.CALLS} component={CallLobbyRoute} options={{ title: 'Calls' }} />
    <CallStack.Screen name={ROUTES.APP.CALL_DETAIL} component={CallSessionRoute} options={{ title: 'Live call' }} />
  </CallStack.Navigator>
);

const AppTabs = () => (
  <Tab.Navigator
    tabBar={(props) => <GlassTabBar {...props} />}
    screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: colors.primary,
    }}
  >
    <Tab.Screen 
      name={ROUTES.APP.GROUPS_TAB} 
      component={GroupStackNavigator} 
      options={({ route }) => ({
        title: 'Groups',
        tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="account-group" color={color} size={size} />,
        tabBarStyle: ((route) => {
          const routeName = getFocusedRouteNameFromRoute(route) ?? ROUTES.APP.GROUPS;
          if (routeName === ROUTES.APP.GROUP_CHAT) {
            return { display: 'none' };
          }
          return undefined;
        })(route),
      })} 
    />
    <Tab.Screen 
      name={ROUTES.APP.CHAT_TAB} 
      component={ChatStackNavigator} 
      options={({ route }) => ({
        title: 'Chat',
        tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="chat-processing" color={color} size={size} />,
        tabBarStyle: ((route) => {
          const routeName = getFocusedRouteNameFromRoute(route) ?? ROUTES.APP.CHAT;
          if (routeName === ROUTES.APP.GROUP_CHAT) {
            return { display: 'none' };
          }
          return undefined;
        })(route),
      })} 
    />
    <Tab.Screen 
      name={ROUTES.APP.CALLS_TAB} 
      component={CallStackNavigator} 
      options={({ route }) => ({
        title: 'Calls',
        tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="phone" color={color} size={size} />,
        tabBarStyle: ((route) => {
          const routeName = getFocusedRouteNameFromRoute(route) ?? ROUTES.APP.CALLS;
          if (routeName === ROUTES.APP.CALL_DETAIL) {
            return { display: 'none' };
          }
          return undefined;
        })(route),
      })} 
    />
    <Tab.Screen 
      name={ROUTES.APP.SETTINGS} 
      component={SettingsScreen} 
      options={{ 
        title: 'Settings',
        tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="cog" color={color} size={size} />,
      }} 
    />
  </Tab.Navigator>
);

export const AppNavigator = () => {
  const { user, loading } = useAuth();

  if (loading) {
    return <LoadingScreen />;
  }

  return <NavigationContainer>{user ? <AppTabs /> : <AuthStackNavigator />}</NavigationContainer>;
};

export default AppNavigator;
