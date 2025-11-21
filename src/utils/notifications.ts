// import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// Notifications.setNotificationHandler({
//   handleNotification: async () => ({
//     shouldShowAlert: true,
//     shouldPlaySound: true,
//     shouldSetBadge: true,
//     shouldShowBanner: true,
//     shouldShowList: true,
//   }),
// });

export const registerForPushNotificationsAsync = async (): Promise<string | null> => {
  if (Platform.OS === 'web') {
    return null;
  }

  console.log('Mocking push token for Expo Go');
  return 'mock-push-token';

//   const settings = await Notifications.getPermissionsAsync();
//   let finalStatus = settings.status;

//   if (finalStatus !== 'granted') {
//     const request = await Notifications.requestPermissionsAsync();
//     finalStatus = request.status;
//   }

//   if (finalStatus !== 'granted') {
//     return null;
//   }

//   const tokenData = await Notifications.getExpoPushTokenAsync();
//   return tokenData.data;
};
