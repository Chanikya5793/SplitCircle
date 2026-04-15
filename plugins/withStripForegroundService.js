const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * Strips FOREGROUND_SERVICE_LOCATION and FOREGROUND_SERVICE_MEDIA_PLAYBACK
 * permissions (and their associated service declarations) from the final
 * AndroidManifest.xml.
 *
 * This is needed because @livekit/react-native-expo-plugin and other
 * third-party plugins inject these permissions automatically.
 * Google Play Console requires video demos for each foreground service
 * permission; removing them lets us publish without videos for now.
 */
const BLOCKED_PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_CAMERA',
];

const withStripForegroundService = (config) => {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    // Strip blocked <uses-permission> entries
    if (manifest['uses-permission']) {
      manifest['uses-permission'] = manifest['uses-permission'].filter(
        (perm) => {
          const name = perm.$?.['android:name'] || '';
          return !BLOCKED_PERMISSIONS.includes(name);
        }
      );
    }

    // Also remove any <service> elements with foregroundServiceType
    const application = manifest.application?.[0];
    if (application?.service) {
      application.service = application.service.filter((svc) => {
        const fgType = svc.$?.['android:foregroundServiceType'] || '';
        // Keep services that don't have a foregroundServiceType
        return !fgType;
      });
    }

    return config;
  });
};

module.exports = withStripForegroundService;
