import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Check if Google Maps API key is configured for the current platform.
 * This prevents crashes on Android when MapView tries to render without a valid API key.
 */
export const hasGoogleMapsApiKey = (): boolean => {
    if (Platform.OS === 'android') {
        const apiKey = getGoogleMapsApiKey();
        if (typeof apiKey === 'string' && apiKey.length > 0) {
            return true;
        }

        // In standalone/dev-client Android builds, Maps key is often injected
        // into AndroidManifest at build time and not visible in expoConfig.
        return Constants.appOwnership !== 'expo';
    }

    if (Platform.OS === 'ios') {
        // iOS uses native Apple Maps (MapKit), which does not require a Google Maps API key.
        return true;
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
        const configKey = Constants.expoConfig?.android?.config?.googleMaps?.apiKey;
        if (typeof configKey === 'string' && configKey.length > 0) {
            return configKey;
        }

        const envKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;
        if (typeof envKey === 'string' && envKey.length > 0) {
            return envKey;
        }

        return undefined;
    }

    if (Platform.OS === 'ios') {
        const configKey = Constants.expoConfig?.ios?.config?.googleMapsApiKey;
        if (typeof configKey === 'string' && configKey.length > 0) {
            return configKey;
        }

        const envKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;
        if (typeof envKey === 'string' && envKey.length > 0) {
            return envKey;
        }

        return undefined;
    }

    return undefined;
};
