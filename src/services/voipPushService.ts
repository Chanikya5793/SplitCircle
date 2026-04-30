import { Platform } from 'react-native';

// react-native-voip-push-notification ships ObjC + a JS index. We require it
// dynamically so the module is only loaded on iOS — Android has no PushKit
// equivalent and importing it on Android would hard-error. The require is also
// wrapped in try/catch so missing-package builds (e.g. before `npm install`)
// don't take the whole bundle down.
type VoipPushEvent = { name?: string; data?: unknown } | unknown;

interface VoipPushModule {
  registerVoipToken: () => void;
  addEventListener: (
    event: 'register' | 'notification' | 'didLoadWithEvents',
    handler: (data: any) => void,
  ) => void;
  getInitialEvents?: () => VoipPushEvent[] | undefined;
}

const debugLog = (...args: unknown[]) => {
  if (__DEV__) {
    console.log('[voipPushService]', ...args);
  }
};

const loadVoipModule = (): VoipPushModule | null => {
  if (Platform.OS !== 'ios') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native-voip-push-notification');
    return (mod?.default ?? mod) as VoipPushModule;
  } catch (error) {
    if (__DEV__) {
      console.warn('[voipPushService] react-native-voip-push-notification not installed yet', error);
    }
    return null;
  }
};

const voipModule: VoipPushModule | null = loadVoipModule();

export interface VoipIncomingPush {
  /** Raw payload as sent by APNs. */
  payload: Record<string, unknown>;
  /** Convenience: app-side call identifier the sender included in the payload. */
  callId: string | null;
}

type TokenListener = (token: string) => void;
type PushListener = (push: VoipIncomingPush) => void;
type RegistrationFailedListener = (error: { code?: number; domain?: string; localizedDescription?: string }) => void;

const tokenListeners = new Set<TokenListener>();
const pushListeners = new Set<PushListener>();
const registrationFailedListeners = new Set<RegistrationFailedListener>();

let lastToken: string | null = null;
let isRegistered = false;
let bufferedPushesFlushed = false;

const extractCallId = (payload: Record<string, unknown>): string | null => {
  const candidates = ['callId', 'uuid', 'callUUID'];
  for (const key of candidates) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
};

const emitToken = (token: string) => {
  lastToken = token;
  for (const listener of tokenListeners) {
    try { listener(token); } catch (error) { console.warn('voip token listener failed', error); }
  }
};

const emitPush = (rawPayload: Record<string, unknown>) => {
  const push: VoipIncomingPush = {
    payload: rawPayload,
    callId: extractCallId(rawPayload),
  };
  for (const listener of pushListeners) {
    try { listener(push); } catch (error) { console.warn('voip push listener failed', error); }
  }
};

const flushBufferedPushes = () => {
  if (!voipModule || bufferedPushesFlushed) return;
  bufferedPushesFlushed = true;

  // The library buffers any push that arrived before JS was ready. Drain it now
  // so we don't miss a call that landed during cold start.
  // @ts-ignore — getInitialEvents exists on iOS at runtime.
  const initialEvents: unknown[] | undefined = voipModule.getInitialEvents?.();
  if (!Array.isArray(initialEvents)) return;

  for (const event of initialEvents) {
    if (!event || typeof event !== 'object') continue;
    const name = (event as { name?: string }).name;
    const data = (event as { data?: unknown }).data;
    if (name === 'RNVoipPushRemoteNotificationsRegisteredEvent' && typeof data === 'string') {
      emitToken(data);
    } else if (name === 'RNVoipPushRemoteNotificationReceivedEvent' && data && typeof data === 'object') {
      emitPush(data as Record<string, unknown>);
    }
  }
};

export function initialize(): void {
  if (!voipModule || isRegistered) return;
  isRegistered = true;

  // Tells iOS to start delivering VoIP pushes. The actual PKPushRegistry was
  // already created in AppDelegate; this just turns on the bridge between the
  // native module and JS so token / push events get forwarded.
  voipModule.registerVoipToken();

  voipModule.addEventListener('register', (token) => {
    if (typeof token !== 'string' || token.length === 0) return;
    emitToken(token);
  });

  voipModule.addEventListener('notification', (notification) => {
    if (!notification || typeof notification !== 'object') return;
    emitPush(notification as Record<string, unknown>);
  });

  voipModule.addEventListener('didLoadWithEvents', (events) => {
    if (!Array.isArray(events)) return;
    for (const event of events) {
      const name = (event as { name?: string })?.name;
      const data = (event as { data?: unknown })?.data;
      if (name === 'RNVoipPushRemoteNotificationsRegisteredEvent' && typeof data === 'string') {
        emitToken(data);
      } else if (name === 'RNVoipPushRemoteNotificationReceivedEvent' && data && typeof data === 'object') {
        emitPush(data as Record<string, unknown>);
      }
    }
  });

  flushBufferedPushes();
  debugLog('initialized');
}

export function getLastToken(): string | null {
  return lastToken;
}

export function onToken(listener: TokenListener): () => void {
  tokenListeners.add(listener);
  if (lastToken) {
    try { listener(lastToken); } catch (error) { console.warn('voip token listener failed', error); }
  }
  return () => { tokenListeners.delete(listener); };
}

export function onIncomingPush(listener: PushListener): () => void {
  pushListeners.add(listener);
  return () => { pushListeners.delete(listener); };
}

export function onRegistrationFailed(listener: RegistrationFailedListener): () => void {
  registrationFailedListeners.add(listener);
  return () => { registrationFailedListeners.delete(listener); };
}

export const voipPushService = {
  initialize,
  getLastToken,
  onToken,
  onIncomingPush,
  onRegistrationFailed,
  isAvailable: voipModule !== null,
};
