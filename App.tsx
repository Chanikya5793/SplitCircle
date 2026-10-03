import { AppAlertHost } from '@/components/AppAlertHost';
import { LiquidBackground } from '@/components/LiquidBackground';
import { MissedCallQuickReply } from '@/components/MissedCallQuickReply';
import { OfflineBanner } from '@/components/OfflineBanner';
import { AuthProvider } from '@/context/AuthContext';
import { DisplayCurrencyProvider } from '@/context/DisplayCurrencyContext';
import { CallProvider } from '@/context/CallContext';
import { ChatProvider } from '@/context/ChatContext';
import { GroupProvider } from '@/context/GroupContext';
import { LoadingProvider } from '@/context/LoadingContext';
import { MonetizationPurchaseProvider } from '@/context/MonetizationPurchaseContext';
import { NotificationProvider } from '@/context/NotificationContext';
import { PrivacyGuardProvider } from '@/context/PrivacyGuardContext';
import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { AppLockProvider, useAppLock } from '@/context/AppLockContext';
import { AppLockGate, GuardTransitionVeil, LockedOverlay, PanicTapZone } from '@/components/ui';
import { PendingPairingGate } from '@/components/ui/PendingPairingGate';
import { ThemeProvider, useTheme } from '@/context/ThemeContext';
import { AppNavigator } from '@/navigation/AppNavigator';
import { StatusBar } from 'expo-status-bar';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { View } from 'react-native';

function ProtectedAppSurface() {
  const { locked } = useAppLock();
  const { fullLock } = usePrivacyGuard();
  const hideContent = locked || fullLock;

  return (
    <>
      <View
        style={{ flex: 1 }}
        accessibilityElementsHidden={hideContent}
        importantForAccessibility={hideContent ? 'no-hide-descendants' : 'auto'}
      >
        <LiquidBackground>
          <OfflineBanner />
          <AppNavigator />
        </LiquidBackground>
        <PanicTapZone />
        <GuardTransitionVeil />
        <AppAlertHost />
        <PendingPairingGate />
      </View>
      <LockedOverlay />
      <AppLockGate />
    </>
  );
}

function AppContent() {
  const { theme, isDark } = useTheme();

  return (
    <LoadingProvider>
      <PaperProvider theme={theme}>
        <AuthProvider>
          <MonetizationPurchaseProvider>
            <NotificationProvider>
              <GroupProvider>
                <ChatProvider>
                  <CallProvider>
                    <MissedCallQuickReply />
                    <AppLockProvider>
                      <DisplayCurrencyProvider>
                      <PrivacyGuardProvider>
                        <StatusBar style={isDark ? "light" : "dark"} />
                        <ProtectedAppSurface />
                      </PrivacyGuardProvider>
                      </DisplayCurrencyProvider>
                    </AppLockProvider>
                  </CallProvider>
                </ChatProvider>
              </GroupProvider>
            </NotificationProvider>
          </MonetizationPurchaseProvider>
        </AuthProvider>
      </PaperProvider>
    </LoadingProvider>
  );
}

function AppRoot() {
  const { theme } = useTheme();
  const appBackground = theme.colors.appBackground;

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
