const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Expo config plugin to add the adi-registration.properties file
 * to the Android assets folder for Google Play Console package name verification.
 */
const withAdiRegistration = (config) => {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const assetsDir = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'assets'
      );

      // Ensure the assets directory exists
      fs.mkdirSync(assetsDir, { recursive: true });

      // Write the verification snippet
      const filePath = path.join(assetsDir, 'adi-registration.properties');
      fs.writeFileSync(filePath, 'DA5XJRQ3D7PHYAAAAAAAAAAAAA\n');

      return config;
    },
  ]);
};

module.exports = withAdiRegistration;
