import { useEffect } from 'react';
import { useNotificationContext } from '@/context/NotificationContext';
import { clearBadgeCount } from '@/utils/notifications';
import { AppState, type AppStateStatus } from 'react-native';

/**
 * Convenience hook that wires up notification badge clearing
 * when the app comes to foreground. The heavy lifting (token registration,
 * preference sync, listeners) lives in NotificationContext.
 */
export const useNotifications = () => {
  const { clearBadge } = useNotificationContext();

  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        void clearBadgeCount();
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [clearBadge]);
};
