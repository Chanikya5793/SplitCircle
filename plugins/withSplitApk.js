const { withAppBuildGradle } = require('@expo/config-plugins');

const withSplitApk = (config) => {
  return withAppBuildGradle(config, config => {
    config.modResults.contents = config.modResults.contents.replace(
      /defaultConfig\s*\{/,
      `splits {
        abi {
            enable true
            reset()
            include "arm64-v8a" // Only build 64-bit ARM to save huge amount of space for verification
            universalApk false
        }
    }
    defaultConfig {`
    );
    return config;
  });
};

module.exports = withSplitApk;
