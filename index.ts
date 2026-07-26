import { registerGlobals } from '@livekit/react-native';
import '@expo/metro-runtime';
import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import 'react-native-get-random-values';

import App from './App';
// Imported at the entry point so TaskManager.defineTask runs in module scope
// — required for the OS to find the task when it launches the app headlessly
// for a silent "revoke" push (stale-notification cleanup while killed).
import { registerBackgroundNotificationTask } from './src/utils/backgroundNotificationTask';
// Imported at the entry point so TaskManager.defineTask runs in module scope —
// iOS can launch the app headlessly straight into the scheduled-backup handler
// (doc 31 §3.6), and a task defined later would not exist yet.
import './src/services/backupScheduler';

// Keep the OS-owned static launch frame in place until the pixel-matched React
// boot screen has painted. This must run in module scope or the splash can
// auto-hide before React gets a chance to take over.
void SplashScreen.preventAutoHideAsync();
SplashScreen.setOptions({ duration: 220, fade: true });

if (!__DEV__) {
        const noOp = () => undefined;
        console.log = noOp;
        console.info = noOp;
        console.debug = noOp;
}

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

const errorUtils = (globalThis as any)?.ErrorUtils;
if (errorUtils?.setGlobalHandler) {
        const defaultHandler = errorUtils.getGlobalHandler?.();
        errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
                if (__DEV__) {
                        console.error('Global runtime error:', error);
                }
                defaultHandler?.(error, isFatal);
        });
}

// Register the background notification task with the OS so silent revoke
// pushes can tidy the tray even when the app is backgrounded or killed.
void registerBackgroundNotificationTask();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
