import { Platform } from 'react-native';
import { v5 as uuidv5 } from 'uuid';

// A FIXED namespace so a callId always maps to the same CallKit UUID on every
// device AND on the server. This is critical: CallKit requires a valid
// RFC-4122 UUID (a raw callId like "call_1783…" makes reportNewIncomingCall
// fail with a nil UUID → the call never rings, only a notification shows). The
// server's VoIP payload derives the uuid the same way (see functions
// voipPush.ts), so the native push path and the JS path agree on one identity.
const CALL_UUID_NAMESPACE = '6f9b8e2a-1c3d-4b5e-8a7f-0d1e2c3b4a59';
export const nativeUuidForCall = (callId: string): string => uuidv5(callId, CALL_UUID_NAMESPACE);

type CallKeepModule = typeof import('react-native-callkeep');
type CallKeepDefault = CallKeepModule['default'];
type CallKeepEventListener = import('react-native-callkeep').EventListener;
type BufferedCallKeepEvent = import('react-native-callkeep').InitialEvents[number];
type RTCAudioSessionType = typeof import('@livekit/react-native-webrtc').RTCAudioSession;

type NativeCallEventMap = {
  answer: {
    appCallId: string | null;
    nativeCallId: string;
  };
  end: {
    appCallId: string | null;
    nativeCallId: string;
  };
  mute: {
    appCallId: string | null;
    nativeCallId: string;
    muted: boolean;
  };
};

type NativeCallEventName = keyof NativeCallEventMap;
type NativeCallEventHandler<EventName extends NativeCallEventName> = (
  payload: NativeCallEventMap[EventName]
) => void;

const isNativePlatform = Platform.OS === 'ios' || Platform.OS === 'android';
const callKeepModule: CallKeepModule | null = isNativePlatform
  ? (require('react-native-callkeep') as CallKeepModule)
  : null;
const RNCallKeep: CallKeepDefault | null = callKeepModule?.default ?? null;
const AudioSessionCategoryOption = callKeepModule?.AudioSessionCategoryOption;
const AudioSessionMode = callKeepModule?.AudioSessionMode;
const RTCAudioSession: RTCAudioSessionType | null = isNativePlatform
  ? ((require('@livekit/react-native-webrtc') as typeof import('@livekit/react-native-webrtc')).RTCAudioSession ?? null)
  : null;

const debugLog = (...args: unknown[]) => {
  if (__DEV__) {
    console.log(...args);
  }
};

const buildBufferedEventKey = (event: BufferedCallKeepEvent): string => {
  return `${event.name}:${JSON.stringify(event.data ?? {})}`;
};

const eventListeners: {
  [EventName in NativeCallEventName]: Set<NativeCallEventHandler<EventName>>;
} = {
  answer: new Set(),
  end: new Set(),
  mute: new Set(),
};

const nativeToAppCallIds = new Map<string, string>();
const appToNativeCallIds = new Map<string, string>();
const handledBufferedEvents = new Set<string>();

// True while CallKit has an active AVAudioSession for a call. useCallManager's
// activation watchdog reads this: if CallKit never activates, JS falls back to
// activating the session itself so the call isn't silent.
let audioSessionActivated = false;

const handleAudioSessionActivated = (source: 'live' | 'buffered') => {
  audioSessionActivated = true;
  debugLog(`nativeCallService: didActivateAudioSession (${source})`);
  RTCAudioSession?.audioSessionDidActivate();
};

const handleAudioSessionDeactivated = (source: 'live' | 'buffered') => {
  audioSessionActivated = false;
  debugLog(`nativeCallService: didDeactivateAudioSession (${source})`);
  RTCAudioSession?.audioSessionDidDeactivate();
};

let isBound = false;
let setupPromise: Promise<boolean> | null = null;
let bufferedListener: CallKeepEventListener | null = null;
let answerListener: CallKeepEventListener | null = null;
let endListener: CallKeepEventListener | null = null;
let muteListener: CallKeepEventListener | null = null;
let didActivateListener: CallKeepEventListener | null = null;
let didDeactivateListener: CallKeepEventListener | null = null;

const emit = <EventName extends NativeCallEventName>(
  eventName: EventName,
  payload: NativeCallEventMap[EventName]
) => {
  for (const listener of eventListeners[eventName]) {
    listener(payload);
  }
};

const ensureMappedNativeCallId = (appCallId: string): string => {
  const existingNativeCallId = appToNativeCallIds.get(appCallId);
  if (existingNativeCallId) {
    return existingNativeCallId;
  }

  // Deterministic (not random) so the native VoIP push path — which reports the
  // call to CallKit before JS is even alive — and this JS path resolve to the
  // exact same CallKit UUID, keeping answer/end events correlated.
  const nativeCallId = nativeUuidForCall(appCallId);
  appToNativeCallIds.set(appCallId, nativeCallId);
  nativeToAppCallIds.set(nativeCallId, appCallId);
  return nativeCallId;
};

const getAppCallId = (nativeCallId: string): string | null => {
  return nativeToAppCallIds.get(nativeCallId) ?? null;
};

const normalizeHandle = (handle: string, appCallId: string): string => {
  const trimmedHandle = handle.trim();
  return trimmedHandle.length > 0 ? trimmedHandle : appCallId;
};

const handleBufferedEvent = (event: BufferedCallKeepEvent) => {
  // Audio-session lifecycle events MUST be processed even when buffered —
  // lock-screen answers deliver them via didLoadWithEvents/getInitialEvents
  // before the live listeners bind. A swallowed activation means WebRTC's
  // audio unit never starts: a silent call. They carry no payload (so the
  // dedup key would collide across calls) and duplicate activations are
  // benign, so they bypass the dedup set entirely.
  if (event.name === 'RNCallKeepDidActivateAudioSession') {
    handleAudioSessionActivated('buffered');
    return;
  }
  if (event.name === 'RNCallKeepDidDeactivateAudioSession') {
    handleAudioSessionDeactivated('buffered');
    return;
  }

  const eventKey = buildBufferedEventKey(event);
  if (handledBufferedEvents.has(eventKey)) {
    return;
  }

  handledBufferedEvents.add(eventKey);

  switch (event.name) {
    case 'RNCallKeepPerformAnswerCallAction': {
      const nativeCallId = event.data.callUUID;
      emit('answer', {
        appCallId: getAppCallId(nativeCallId),
        nativeCallId,
      });
      break;
    }
    case 'RNCallKeepPerformEndCallAction': {
      const nativeCallId = event.data.callUUID;
      emit('end', {
        appCallId: getAppCallId(nativeCallId),
        nativeCallId,
      });
      break;
    }
    case 'RNCallKeepDidPerformSetMutedCallAction': {
      const nativeCallId = event.data.callUUID;
      emit('mute', {
        appCallId: getAppCallId(nativeCallId),
        nativeCallId,
        muted: event.data.muted,
      });
      break;
    }
    default:
      break;
  }
};

const bindListeners = () => {
  if (!RNCallKeep || isBound) {
    return;
  }

  isBound = true;

  bufferedListener = RNCallKeep.addEventListener('didLoadWithEvents', (events) => {
    events.forEach(handleBufferedEvent);
  });

  answerListener = RNCallKeep.addEventListener('answerCall', ({ callUUID }) => {
    emit('answer', {
      appCallId: getAppCallId(callUUID),
      nativeCallId: callUUID,
    });
  });

  endListener = RNCallKeep.addEventListener('endCall', ({ callUUID }) => {
    emit('end', {
      appCallId: getAppCallId(callUUID),
      nativeCallId: callUUID,
    });
  });

  muteListener = RNCallKeep.addEventListener('didPerformSetMutedCallAction', ({ callUUID, muted }) => {
    emit('mute', {
      appCallId: getAppCallId(callUUID),
      nativeCallId: callUUID,
      muted,
    });
  });

  didActivateListener = RNCallKeep.addEventListener('didActivateAudioSession', () => {
    handleAudioSessionActivated('live');
  });

  didDeactivateListener = RNCallKeep.addEventListener('didDeactivateAudioSession', () => {
    handleAudioSessionDeactivated('live');
  });
};

const flushBufferedEvents = async () => {
  if (!RNCallKeep) {
    return;
  }

  try {
    const bufferedEvents = await RNCallKeep.getInitialEvents();
    bufferedEvents.forEach(handleBufferedEvent);
    RNCallKeep.clearInitialEvents();
  } catch (error) {
    console.warn('nativeCallService.flushBufferedEvents failed', error);
  }
};

const createSetupOptions = (): Parameters<CallKeepDefault['setup']>[0] => ({
  ios: {
    appName: 'ManaSplit',
    supportsVideo: true,
    includesCallsInRecents: true,
    maximumCallGroups: '1',
    maximumCallsPerCallGroup: '1',
    // NO defaultToSpeaker here: this config is applied by CallKit for EVERY
    // call, and with it audio calls activate on the loudspeaker — and while
    // it's in the live options, overrideOutputAudioPort(.none) can never
    // route back to the earpiece (the speaker button appears dead). Video
    // calls get the speaker via configureAudio/preferBluetoothAudio instead.
    audioSession: AudioSessionCategoryOption && AudioSessionMode
      ? {
          categoryOptions:
            AudioSessionCategoryOption.allowBluetooth
            | AudioSessionCategoryOption.allowBluetoothA2DP
            | AudioSessionCategoryOption.allowAirPlay,
          mode: AudioSessionMode.voiceChat,
        }
      : undefined,
  },
  android: {
    alertTitle: 'Enable calling permissions',
    alertDescription:
      'ManaSplit needs phone account access to show native call UI and keep calls working in the background.',
    cancelButton: 'Cancel',
    okButton: 'Continue',
    additionalPermissions: [],
    foregroundService: {
      channelId: 'com.splitcircle.app.calls',
      channelName: 'Calls',
      notificationTitle: 'ManaSplit call in progress',
    },
  },
});

async function initialize(): Promise<boolean> {
  if (!RNCallKeep) {
    return false;
  }

  bindListeners();

  if (!setupPromise) {
    setupPromise = RNCallKeep.setup(createSetupOptions())
      .then(async (accepted) => {
        debugLog(`nativeCallService initialized: ${accepted ? 'ready' : 'permission-pending'}`);
        RNCallKeep.setReachable();
        if (Platform.OS === 'android') {
          RNCallKeep.setAvailable(true);
        }
        await flushBufferedEvents();
        return accepted;
      })
      .catch((error) => {
        console.warn('nativeCallService.initialize failed', error);
        return false;
      });
  }

  return setupPromise;
}

async function setAvailability(isAvailable: boolean): Promise<void> {
  if (!RNCallKeep) {
    return;
  }

  await initialize();
  if (Platform.OS === 'android') {
    RNCallKeep.setAvailable(isAvailable);
  }
}

async function startOutgoingCall(
  appCallId: string,
  handle: string,
  displayName: string,
  hasVideo: boolean
): Promise<void> {
  if (!RNCallKeep) {
    return;
  }

  await initialize();
  const nativeCallId = ensureMappedNativeCallId(appCallId);
  RNCallKeep.startCall(
    nativeCallId,
    normalizeHandle(handle, appCallId),
    displayName,
    'generic',
    hasVideo
  );
}

async function displayIncomingCall(
  appCallId: string,
  handle: string,
  displayName: string,
  hasVideo: boolean
): Promise<void> {
  if (!RNCallKeep) {
    return;
  }

  await initialize();
  const nativeCallId = ensureMappedNativeCallId(appCallId);
  RNCallKeep.displayIncomingCall(
    nativeCallId,
    normalizeHandle(handle, appCallId),
    displayName,
    'generic',
    hasVideo
  );
}

async function answerIncomingCall(appCallId: string): Promise<void> {
  if (!RNCallKeep) {
    return;
  }

  await initialize();
  const nativeCallId = ensureMappedNativeCallId(appCallId);
  RNCallKeep.answerIncomingCall(nativeCallId);
}

async function rejectIncomingCall(appCallId: string): Promise<void> {
  if (!RNCallKeep) {
    return;
  }

  await initialize();
  const nativeCallId = appToNativeCallIds.get(appCallId);
  if (!nativeCallId) {
    return;
  }

  RNCallKeep.rejectCall(nativeCallId);
}

async function markCallConnected(
  appCallId: string,
  direction: 'incoming' | 'outgoing'
): Promise<void> {
  if (!RNCallKeep) {
    return;
  }

  await initialize();
  const nativeCallId = appToNativeCallIds.get(appCallId);
  if (!nativeCallId) {
    return;
  }

  if (Platform.OS === 'ios' && direction === 'outgoing') {
    RNCallKeep.reportConnectedOutgoingCallWithUUID(nativeCallId);
  }

  if (Platform.OS === 'android') {
    (RNCallKeep as unknown as {
      setCurrentCallActive?: (callId: string) => void;
    }).setCurrentCallActive?.(nativeCallId);
  }
}

async function endCall(appCallId: string): Promise<void> {
  if (!RNCallKeep) {
    return;
  }

  await initialize();
  const nativeCallId = appToNativeCallIds.get(appCallId);
  if (!nativeCallId) {
    return;
  }

  RNCallKeep.endCall(nativeCallId);
}

function clearCall(appCallId: string): void {
  const nativeCallId = appToNativeCallIds.get(appCallId);
  if (!nativeCallId) {
    return;
  }

  appToNativeCallIds.delete(appCallId);
  nativeToAppCallIds.delete(nativeCallId);
}

function bringAppToForeground(): void {
  if (!RNCallKeep || Platform.OS !== 'android') {
    return;
  }

  (
    RNCallKeep as unknown as {
      backToForeground?: () => void;
    }
  ).backToForeground?.();
}

function subscribe<EventName extends NativeCallEventName>(
  eventName: EventName,
  handler: NativeCallEventHandler<EventName>
): () => void {
  eventListeners[eventName].add(handler);
  return () => {
    eventListeners[eventName].delete(handler);
  };
}

/**
 * Whether CallKit owns AVAudioSession activation on this device. When true,
 * JS must never call setActive itself (Apple forbids it — racing CallKit's
 * activation leaves WebRTC's audio unit wired to a dead session: silent call).
 * Configure the session, then wait for provider:didActivateAudioSession.
 */
function managesAudioSession(): boolean {
  return Platform.OS === 'ios' && RNCallKeep != null;
}

/** True while CallKit's AVAudioSession activation is in effect. */
function hasActivatedAudioSession(): boolean {
  return audioSessionActivated;
}

export const nativeCallService = {
  initialize,
  setAvailability,
  managesAudioSession,
  hasActivatedAudioSession,
  startOutgoingCall,
  displayIncomingCall,
  answerIncomingCall,
  rejectIncomingCall,
  markCallConnected,
  endCall,
  clearCall,
  bringAppToForeground,
  subscribe,
};
