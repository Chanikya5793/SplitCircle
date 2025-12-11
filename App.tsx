import { LiquidBackground } from '@/components/LiquidBackground';
import { AuthProvider } from '@/context/AuthContext';
import { CallProvider } from '@/context/CallContext';
import { ChatProvider } from '@/context/ChatContext';
import { GroupProvider } from '@/context/GroupContext';
import { ThemeProvider, useTheme } from '@/context/ThemeContext';
import { AppNavigator } from '@/navigation/AppNavigator';
import { StatusBar } from 'expo-status-bar';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { GestureHandlerRootView } from 'react-native-gesture-handler';

function AppContent() {
  const { theme, isDark } = useTheme();

  return (
    <PaperProvider theme={theme}>
      <AuthProvider>
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
      </AuthProvider>
    </PaperProvider>
  );
}

export default function App() {
  console.log('Rendering App component');
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AppContent />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
