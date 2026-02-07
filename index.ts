import { registerGlobals } from '@livekit/react-native';
import '@expo/metro-runtime';
import { registerRootComponent } from 'expo';
import 'react-native-get-random-values';

import App from './App';

if (typeof (globalThis as any).Event !== 'function') {
	class EventPolyfill {
		type: string;
		constructor(type: string) {
			this.type = type;
		}
	}
	(globalThis as any).Event = EventPolyfill;
}

if (typeof (globalThis as any).CustomEvent !== 'function') {
	class CustomEventPolyfill extends (globalThis as any).Event {
		detail: unknown;
		constructor(type: string, params?: { detail?: unknown }) {
			super(type);
			this.detail = params?.detail;
		}
	}
	(globalThis as any).CustomEvent = CustomEventPolyfill;
}

// Initialize LiveKit WebRTC globals - MUST be called before any LiveKit usage
registerGlobals();
console.log('✅ LiveKit WebRTC globals registered');

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
