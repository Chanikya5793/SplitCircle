import 'react-native-gesture-handler';

import { OfflineBanner } from '@/components/OfflineBanner';
import { colors, theme } from '@/constants';
import { AuthProvider } from '@/context/AuthContext';
import { ChatProvider } from '@/context/ChatContext';
import { GroupProvider } from '@/context/GroupContext';
import { useNotifications } from '@/hooks/useNotifications';
import AppNavigator from '@/navigation/AppNavigator';
import { StatusBar } from 'expo-status-bar';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

const AppContent = () => {
  useNotifications();
  return (
    <>
      <OfflineBanner />
      <AppNavigator />
    </>
  );
};

export default function App() {
  return (
    <SafeAreaProvider>
      <PaperProvider theme={theme}>
        <AuthProvider>
          <GroupProvider>
            <ChatProvider>
              <AppContent />
              <StatusBar style="light" backgroundColor={colors.primary} />
            </ChatProvider>
          </GroupProvider>
        </AuthProvider>
      </PaperProvider>
    </SafeAreaProvider>
  );
}
