import { theme } from '@/constants/theme';
import { AuthProvider } from '@/context/AuthContext';
import { ChatProvider } from '@/context/ChatContext';
import { GroupProvider } from '@/context/GroupContext';
import { AppNavigator } from '@/navigation/AppNavigator';
import { StatusBar } from 'expo-status-bar';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function App() {
  return (
    <SafeAreaProvider>
      <PaperProvider theme={theme}>
        <AuthProvider>
          <GroupProvider>
            <ChatProvider>
              <StatusBar style="auto" />
              <AppNavigator />
            </ChatProvider>
          </GroupProvider>
        </AuthProvider>
      </PaperProvider>
    </SafeAreaProvider>
  );
}
