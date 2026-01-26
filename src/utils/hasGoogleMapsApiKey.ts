import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Check if Google Maps API key is configured for the current platform.
 * This prevents crashes on Android when MapView tries to render without a valid API key.
 */
export const hasGoogleMapsApiKey = (): boolean => {
    if (Platform.OS === 'android') {
        const apiKey = Constants.expoConfig?.android?.config?.googleMaps?.apiKey;
        return typeof apiKey === 'string' && apiKey.length > 0;
    }

    if (Platform.OS === 'ios') {
        const apiKey = Constants.expoConfig?.ios?.config?.googleMapsApiKey;
        return typeof apiKey === 'string' && apiKey.length > 0;
    }

    // Web or other platforms - assume Maps is available (uses browser's Maps)
    return true;
};

/**
 * Get the Google Maps API key for the current platform.
 * Returns undefined if not configured.
 */
export const getGoogleMapsApiKey = (): string | undefined => {
    if (Platform.OS === 'android') {
        return Constants.expoConfig?.android?.config?.googleMaps?.apiKey;
    }

    if (Platform.OS === 'ios') {
        return Constants.expoConfig?.ios?.config?.googleMapsApiKey;
    }

    return undefined;
};
