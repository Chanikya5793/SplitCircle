import { Camera } from 'expo-camera';
import * as Location from 'expo-location';
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

/**
 * Request foreground location permissions.
 * @returns true if permission was granted, false otherwise
 */
export const requestForegroundLocationPermission = async (): Promise<boolean> => {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status === 'granted';
};

/**
 * Request background ("Always") location permissions.
 * On Android, this requires foreground permission to be granted first.
 * This will trigger the system dialog with "Allow all the time" option.
 * @returns true if permission was granted, false otherwise
 */
export const requestBackgroundLocationPermission = async (): Promise<boolean> => {
  // First ensure foreground permissions are granted (required on Android)
  const { status: foregroundStatus } = await Location.getForegroundPermissionsAsync();
  
  if (foregroundStatus !== 'granted') {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      return false;
    }
  }

  // Now request background permissions
  const { status: backgroundStatus } = await Location.requestBackgroundPermissionsAsync();
  return backgroundStatus === 'granted';
};

/**
 * Check if background location permission is currently granted.
 * @returns true if permission is granted, false otherwise
 */
export const hasBackgroundLocationPermission = async (): Promise<boolean> => {
  const { status } = await Location.getBackgroundPermissionsAsync();
  return status === 'granted';
};
