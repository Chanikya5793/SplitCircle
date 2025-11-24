import { LiquidBackground } from '@/components/LiquidBackground';
import { theme } from '@/constants/theme';
import { AuthProvider } from '@/context/AuthContext';
import { ChatProvider } from '@/context/ChatContext';
import { GroupProvider } from '@/context/GroupContext';
import { AppNavigator } from '@/navigation/AppNavigator';
import { StatusBar } from 'expo-status-bar';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function App() {
  console.log('Rendering App component');
  return (
    <SafeAreaProvider>
      <PaperProvider theme={theme}>
        <AuthProvider>
          <GroupProvider>
            <ChatProvider>
              <StatusBar style="auto" />
              <LiquidBackground>
                <AppNavigator />
              </LiquidBackground>
            </ChatProvider>
          </GroupProvider>
        </AuthProvider>
      </PaperProvider>
    </SafeAreaProvider>
  );
}
