import { useEffect } from 'react';
// import * as Notifications from 'expo-notifications';
import { useAuth } from '@/context/AuthContext';
import { db } from '@/firebase';
import { registerForPushNotificationsAsync } from '@/utils/notifications';
import { doc, updateDoc } from 'firebase/firestore';

export const useNotifications = () => {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) {
      return () => undefined;
    }

    // let notificationSub: Notifications.Subscription | undefined;

    const syncToken = async () => {
      const token = await registerForPushNotificationsAsync();
      if (token) {
        await updateDoc(doc(db, 'users', user.userId), {
          pushToken: token,
          'preferences.pushEnabled': true,
        });
      }
    };

    syncToken();

    // notificationSub = Notifications.addNotificationResponseReceivedListener((response) => {
    //   console.log('Open notification payload', response.notification.request.content.data);
    // });

    return () => {
      // notificationSub?.remove();
    };
  }, [user?.userId]);
};
