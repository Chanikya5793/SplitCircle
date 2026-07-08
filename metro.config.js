const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Some native-only packages call requireNativeComponent /
// TurboModuleRegistry.getEnforcing at module-eval time, which react-native-web
// 0.21 no longer provides — a single one crashes the entire web bundle.
// Those features (calls, video trim) are native-only, so on web we swap the
// packages for no-op shims.
const WEB_SHIMS = {
  '@livekit/react-native': path.resolve(__dirname, 'web-shims/livekit-react-native.js'),
  '@livekit/react-native-webrtc': path.resolve(__dirname, 'web-shims/livekit-react-native.js'),
  'react-native-video-trim': path.resolve(__dirname, 'web-shims/video-trim.js'),
};

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web') {
    const shimmed = Object.keys(WEB_SHIMS).find(
      (pkg) => moduleName === pkg || moduleName.startsWith(`${pkg}/`),
    );
    if (shimmed) {
      return { type: 'sourceFile', filePath: WEB_SHIMS[shimmed] };
    }
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
