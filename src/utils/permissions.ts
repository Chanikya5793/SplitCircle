import { Camera } from 'expo-camera';
// import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export const requestCameraAndAudioPermissions = async (): Promise<boolean> => {
  const { status: cameraStatus } = await Camera.requestCameraPermissionsAsync();
  const { status: micStatus } = await Camera.requestMicrophonePermissionsAsync();
  return cameraStatus === 'granted' && micStatus === 'granted';
};

export const requestPushPermissions = async (): Promise<boolean> => {
  if (Platform.OS === 'web') {
    return false;
  }

  console.log('Mocking push permissions for Expo Go');
  return true;

//   const { status } = await Notifications.getPermissionsAsync();
//   if (status === 'granted') {
//     return true;
//   }
//   const { status: requestedStatus } = await Notifications.requestPermissionsAsync();
//   return requestedStatus === 'granted';
};
