import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
  // iOS Phone-app Recents redial (CXStartCallAction / INStartCallIntent).
  // `handle` is whatever we reported the original call with (peer userId for
  // 1:1, chatId for groups). `nativeCallId` is only present when CallKit
  // actually created a placeholder call (performStartCallAction path); the
  // Recents/Siri user-activity path delivers handle+video only.
  startCall: {
    handle: string;
    nativeCallId: string | null;
    hasVideo: boolean;
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
  startCall: new Set(),
};

// Recents redials can arrive before any JS consumer has subscribed (cold
// start: buffered events are flushed during initialize(), but CallContext
// subscribes later). Park them here and replay on subscribe.
const pendingStartCallEvents: NativeCallEventMap['startCall'][] = [];

const nativeToAppCallIds = new Map<string, string>();
const appToNativeCallIds = new Map<string, string>();
const handledBufferedEvents = new Set<string>();

// True while CallKit has an active AVAudioSession for a call. useCallManager's
// activation watchdog reads this: if CallKit never activates, JS falls back to
// activating the session itself so the call isn't silent.
let audioSessionActivated = false;

// True only when JS (the watchdog fallback), NOT CallKit, activated the
// session. CallKit balances its own activation with a later
// didDeactivateAudioSession; a JS-owned activation has no such counterpart, so
// teardown must deactivate it explicitly or the next call inherits a live but
// orphaned session and is silent.
let audioSessionActivatedByFallback = false;

const handleAudioSessionActivated = (source: 'live' | 'buffered') => {
  audioSessionActivated = true;
  // A genuine CallKit activation means CallKit now owns deactivation — even if
  // the watchdog fallback already fired, CallKit's later didDeactivate will
  // tear the session down, so JS must not also deactivate it.
  audioSessionActivatedByFallback = false;
  debugLog(`nativeCallService: didActivateAudioSession (${source})`);
  RTCAudioSession?.audioSessionDidActivate();
};

const handleAudioSessionDeactivated = (source: 'live' | 'buffered') => {
  audioSessionActivated = false;
  audioSessionActivatedByFallback = false;
  debugLog(`nativeCallService: didDeactivateAudioSession (${source})`);
  RTCAudioSession?.audioSessionDidDeactivate();
};

let isBound = false;
let setupPromise: Promise<boolean> | null = null;
let bufferedListener: CallKeepEventListener | null = null;
let answerListener: CallKeepEventListener | null = null;
let endListener: CallKeepEventListener | null = null;
let muteListener: CallKeepEventListener | null = null;
let startCallListener: CallKeepEventListener | null = null;
let didActivateListener: CallKeepEventListener | null = null;
let didDeactivateListener: CallKeepEventListener | null = null;

const emit = <EventName extends NativeCallEventName>(
  eventName: EventName,
  payload: NativeCallEventMap[EventName]
) => {
  if (eventName === 'startCall' && eventListeners.startCall.size === 0) {
    pendingStartCallEvents.push(payload as NativeCallEventMap['startCall']);
    return;
  }

  for (const listener of eventListeners[eventName]) {
    listener(payload);
  }
};

/**
 * Whether a CallKit UUID belongs to a call THIS APP initiated (outgoing call
 * or incoming call it reported). Mappings are registered in
 * ensureMappedNativeCallId BEFORE RNCallKeep.startCall runs, so the CallKit
 * echo of our own outgoing call is always identifiable by the time it fires.
 * Case-insensitive: we generate lowercase uuidv5, but iOS NSUUID round-trips
 * can uppercase.
 */
const isAppInitiatedNativeCall = (nativeCallId: string): boolean => {
  return (
    nativeToAppCallIds.has(nativeCallId)
    || nativeToAppCallIds.has(nativeCallId.toLowerCase())
  );
};

// ---------------------------------------------------------------------------
// Crash-safe record of app-initiated outgoing CallKit UUIDs.
//
// The in-memory nativeToAppCallIds map identifies CallKit's echo of our own
// RNCallKeep.startCall (see emitStartCall). But if the process dies right
// after startCall (crash / force-kill), that echo can arrive as a BUFFERED
// event on the NEXT launch — with a fresh, empty map. Unrecognized, it would
// look like a Phone-app Recents redial and silently auto-place a phantom
// call on launch. So every outgoing UUID is ALSO persisted to AsyncStorage
// (awaited BEFORE startCall fires, so it's on disk even if we die
// immediately after) and consulted as a fallback.
//
// This can never suppress a genuine Recents redial: our outgoing UUIDs are
// deterministic uuidv5 values from unique app callIds, while a real redial
// carries either no UUID (INStartCallIntent path) or a random
// CallKit-generated placeholder UUID.
// ---------------------------------------------------------------------------
const RECENT_OUTGOING_CALLS_KEY = 'nativeCallService.recentOutgoingNativeCallIds';
const RECENT_OUTGOING_CALL_TTL_MS = 10 * 60 * 1000;

type PersistedOutgoingCall = { nativeCallId: string; at: number };

const parsePersistedOutgoingCalls = (raw: string | null): PersistedOutgoingCall[] => {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const cutoff = Date.now() - RECENT_OUTGOING_CALL_TTL_MS;
    return parsed.filter(
      (entry): entry is PersistedOutgoingCall =>
        typeof entry === 'object'
        && entry !== null
        && typeof (entry as PersistedOutgoingCall).nativeCallId === 'string'
        && typeof (entry as PersistedOutgoingCall).at === 'number'
        && (entry as PersistedOutgoingCall).at >= cutoff
    );
  } catch {
    return [];
  }
};

// Lowercased UUIDs of recent app-initiated outgoing calls, loaded once per
// process. Memoized as a promise so a buffered start-call event flushed
// during initialize() can await the read instead of racing it.
let persistedOutgoingUuidsPromise: Promise<Set<string>> | null = null;

const loadPersistedOutgoingUuids = (): Promise<Set<string>> => {
  if (!persistedOutgoingUuidsPromise) {
    persistedOutgoingUuidsPromise = AsyncStorage.getItem(RECENT_OUTGOING_CALLS_KEY)
      .then((raw) => new Set(
        parsePersistedOutgoingCalls(raw).map((entry) => entry.nativeCallId.toLowerCase())
      ))
      .catch((error) => {
        console.warn('nativeCallService: failed to load persisted outgoing call ids', error);
        return new Set<string>();
      });
  }
  return persistedOutgoingUuidsPromise;
};

const persistAppInitiatedNativeCall = async (nativeCallId: string): Promise<void> => {
  try {
    // Keep the in-memory snapshot coherent for later buffered checks.
    (await loadPersistedOutgoingUuids()).add(nativeCallId.toLowerCase());
    const raw = await AsyncStorage.getItem(RECENT_OUTGOING_CALLS_KEY);
    const entries = parsePersistedOutgoingCalls(raw)
      .filter((entry) => entry.nativeCallId.toLowerCase() !== nativeCallId.toLowerCase());
    entries.push({ nativeCallId: nativeCallId.toLowerCase(), at: Date.now() });
    await AsyncStorage.setItem(RECENT_OUTGOING_CALLS_KEY, JSON.stringify(entries));
  } catch (error) {
    // Non-fatal: the in-memory map still covers the common (no-crash) case.
    console.warn('nativeCallService: failed to persist outgoing call id', error);
  }
};

const wasRecentlyAppInitiated = async (nativeCallId: string): Promise<boolean> => {
  const persisted = await loadPersistedOutgoingUuids();
  return persisted.has(nativeCallId.toLowerCase());
};

const emitStartCall = (data: { handle?: string; callUUID?: string; video?: boolean; name?: string }) => {
  const handle = typeof data.handle === 'string' ? data.handle.trim() : '';
  if (!handle) {
    return;
  }

  const nativeCallId = typeof data.callUUID === 'string' && data.callUUID.length > 0 ? data.callUUID : null;

  // CallKit echoes the app's OWN outgoing calls back through
  // didReceiveStartCallAction (RNCallKeep.startCall → CXStartCallAction →
  // provider delegate → JS). That echo is NOT a Phone-app Recents redial —
  // forwarding it would make the redial flow dismiss the live outgoing call
  // the instant it starts. Genuine Recents/Siri redials arrive with either no
  // UUID (INStartCallIntent user-activity path) or a CallKit-created
  // placeholder UUID that is never in our mapping.
  if (nativeCallId && isAppInitiatedNativeCall(nativeCallId)) {
    return;
  }

  if (!nativeCallId) {
    emit('startCall', {
      handle,
      nativeCallId,
      hasVideo: data.video === true,
    });
    return;
  }

  // The UUID isn't in the in-memory map — but if the app died right after
  // placing this call, its echo arrives buffered on the next launch with an
  // empty map. Consult the crash-safe persisted record before treating it as
  // a Recents redial; without this check the app would silently auto-redial
  // on launch. Emitting after the async read is safe: startCall consumers
  // either get the event live or via the parked-events replay in subscribe.
  void wasRecentlyAppInitiated(nativeCallId).then((appInitiated) => {
    if (appInitiated) {
      debugLog('nativeCallService: ignoring start-call echo persisted from a previous launch');
      return;
    }
    emit('startCall', {
      handle,
      nativeCallId,
      hasVideo: data.video === true,
    });
  });
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
    case 'RNCallKeepDidReceiveStartCallAction': {
      // Recents redial delivered before JS was alive (cold start).
      emitStartCall(event.data as { handle?: string; callUUID?: string; video?: boolean });
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

  startCallListener = RNCallKeep.addEventListener('didReceiveStartCallAction', (data) => {
    // iOS Phone-app Recents / Siri redial while the app is running. The
    // user-activity (INStartCallIntent) path carries no callUUID and creates
    // no CallKit call; the CXStartCallAction path includes one.
    emitStartCall(data as { handle?: string; callUUID?: string; video?: boolean });
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
  // Awaited BEFORE startCall: if the process dies right after placing the
  // call, the next launch can still recognize CallKit's buffered echo of it
  // and not mistake it for a Recents redial (phantom auto-redial on launch).
  await persistAppInitiatedNativeCall(nativeCallId);
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
  // Deterministic mapping (uuidv5) — NOT appToNativeCallIds.get. On a VoIP
  // cold start the native AppDelegate reported the CallKit call before JS
  // existed, so no in-memory mapping exists yet; deriving the UUID lets JS
  // dismiss that natively-reported call (ending an unknown UUID is a no-op).
  const nativeCallId = ensureMappedNativeCallId(appCallId);
  RNCallKeep.endCall(nativeCallId);
}

/**
 * End a CallKit call identified by its NATIVE UUID (no app-call mapping).
 * Used to dismiss the placeholder call CallKit creates for a Recents redial
 * via CXStartCallAction before the app launches its own outgoing call flow.
 */
async function dismissNativeCall(nativeCallId: string): Promise<void> {
  if (!RNCallKeep) {
    return;
  }

  await initialize();
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

  if (eventName === 'startCall' && pendingStartCallEvents.length > 0) {
    const parked = pendingStartCallEvents.splice(0, pendingStartCallEvents.length);
    for (const payload of parked) {
      (handler as NativeCallEventHandler<'startCall'>)(payload);
    }
  }

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

/**
 * iOS watchdog fallback (see useCallManager.setupCallAudio). When CallKit's
 * provider:didActivateAudioSession never arrives, JS activates the
 * AVAudioSession itself — but AudioSession.startAudioSession() alone leaves
 * WebRTC's audio unit wired to a session it still believes is inactive: the
 * classic silent call. This notifies the WebRTC layer that the session is now
 * live and records that JS (not CallKit) owns the activation, so teardown
 * deactivates it. Idempotent: a no-op once the session is already active
 * (CallKit beat the watchdog, or the fallback already ran). iOS-only — the
 * platform guard stays here so callers never branch on Platform.OS.
 */
function activateAudioSessionFallback(): void {
  if (Platform.OS !== 'ios') {
    return;
  }
  if (audioSessionActivated) {
    return;
  }
  audioSessionActivated = true;
  audioSessionActivatedByFallback = true;
  debugLog('nativeCallService: activateAudioSessionFallback (watchdog took over)');
  RTCAudioSession?.audioSessionDidActivate();
}

/**
 * Whether JS — not CallKit — must tear down the AVAudioSession. True on Android
 * (no CallKit), on iOS when the session was never activated, and on iOS when
 * the watchdog fallback activated it (CallKit won't deactivate a session it
 * never activated). Callers must snapshot this BEFORE resetAudioSession()
 * clears the underlying flags.
 */
function jsOwnsAudioSession(): boolean {
  return !managesAudioSession() || !audioSessionActivated || audioSessionActivatedByFallback;
}

/**
 * Tear down audio-session state at the end of a call. CallKit balances its own
 * activation with provider:didDeactivateAudioSession, but a JS (watchdog)
 * activation has no such counterpart — so when JS owned it we notify WebRTC the
 * session is going away. Either way the activation flags are cleared
 * defensively: a stuck `true` (e.g. a missed CallKit deactivation on a
 * backgrounded teardown) would otherwise make the NEXT call silent until an app
 * restart. iOS-guarded; elsewhere it only clears the flags. Idempotent.
 */
function resetAudioSession(): void {
  if (Platform.OS === 'ios' && audioSessionActivatedByFallback) {
    debugLog('nativeCallService: deactivating JS-activated audio session (teardown)');
    RTCAudioSession?.audioSessionDidDeactivate();
  }
  audioSessionActivated = false;
  audioSessionActivatedByFallback = false;
}

export const nativeCallService = {
  initialize,
  setAvailability,
  managesAudioSession,
  hasActivatedAudioSession,
  activateAudioSessionFallback,
  jsOwnsAudioSession,
  resetAudioSession,
  isAppInitiatedNativeCall,
  startOutgoingCall,
  displayIncomingCall,
  answerIncomingCall,
  rejectIncomingCall,
  markCallConnected,
  endCall,
  dismissNativeCall,
  clearCall,
  bringAppToForeground,
  subscribe,
};
