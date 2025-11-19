import '@expo/metro-runtime';
import { registerRootComponent } from 'expo';

import App from './App';

console.log('Bootstrapping SplitCircle app entry');

const errorUtils = (globalThis as any)?.ErrorUtils;
if (errorUtils?.setGlobalHandler) {
	const defaultHandler = errorUtils.getGlobalHandler?.();
	errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
		console.error('Global runtime error:', error);
		defaultHandler?.(error, isFatal);
	});
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);

