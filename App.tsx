import { LiquidBackground } from '@/components/LiquidBackground';
import { AuthProvider } from '@/context/AuthContext';
import { CallProvider } from '@/context/CallContext';
import { ChatProvider } from '@/context/ChatContext';
import { GroupProvider } from '@/context/GroupContext';
import { LoadingProvider } from '@/context/LoadingContext';
import { NotificationProvider } from '@/context/NotificationContext';
import { ThemeProvider, useTheme } from '@/context/ThemeContext';
import { AppNavigator } from '@/navigation/AppNavigator';
import { StatusBar } from 'expo-status-bar';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { GestureHandlerRootView } from 'react-native-gesture-handler';

function AppContent() {
  const { theme, isDark } = useTheme();

  return (
    <LoadingProvider>
      <PaperProvider theme={theme}>
        <AuthProvider>
          <NotificationProvider>
            <GroupProvider>
              <ChatProvider>
                <CallProvider>
                  <StatusBar style={isDark ? "light" : "dark"} />
                  <LiquidBackground>
                    <AppNavigator />
                  </LiquidBackground>
                </CallProvider>
              </ChatProvider>
            </GroupProvider>
          </NotificationProvider>
        </AuthProvider>
      </PaperProvider>
    </LoadingProvider>
  );
}

function AppRoot() {
  const { isDark } = useTheme();
  const appBackground = isDark ? '#121212' : '#FDFBFB';

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: appBackground }}>
      <SafeAreaProvider style={{ flex: 1, backgroundColor: appBackground }}>
        <AppContent />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppRoot />
    </ThemeProvider>
  );
}
