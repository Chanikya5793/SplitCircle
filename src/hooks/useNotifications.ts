import { useEffect } from 'react';
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

    let isMounted = true;

    const syncToken = async () => {
      try {
        const token = await registerForPushNotificationsAsync();
        if (token && isMounted) {
          await updateDoc(doc(db, 'users', user.userId), {
            pushToken: token,
            'preferences.pushEnabled': true,
          });
        }
      } catch (error) {
        console.error('Failed to register push notifications', error);
      }
    };

    void syncToken();

    return () => {
      isMounted = false;
    };
  }, [user?.userId]);
};
