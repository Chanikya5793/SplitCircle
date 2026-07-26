import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { v5 as uuidv5 } from 'uuid';
import { appendCallDebug } from './callDebugLedger';

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
const CallKeepConstants = callKeepModule?.CONSTANTS;
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
// Parallel to appToNativeCallIds, keyed the same — when each mapping was
// created. dismissNativeCall's audio-reset guard uses this to tell a
// genuinely live call apart from an orphaned entry left behind by a
// teardown path that never called clearCall (crash, force-kill): the map
// itself can't distinguish "live" from "stuck" on size alone.
const appToNativeCallMappedAt = new Map<string, number>();
// Generous upper bound on how long a real call could plausibly still be live.
const MAX_PLAUSIBLE_CALL_DURATION_MS = 4 * 60 * 60 * 1000;
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

// WebRTC manual-audio bridge. With manual audio on, WebRTC never starts/stops
// the audio unit itself — it does so only when we call setAudioEnabled, gated
// on CallKit's audio-session activation. This is the canonical CallKit + WebRTC
// fix for calls that negotiate media but stay silent (WebRTC otherwise starts
// the audio unit against a session CallKit hasn't activated yet). Both helpers
// are wrapped defensively: the patched native methods only exist after the iOS
// binary is rebuilt, and the JS wrapper additionally no-ops when they are
// missing — so an older dev-client must degrade to the previous behaviour, not
// crash. Any failure is logged, never thrown.
const setWebRtcManualAudio = (enabled: boolean): void => {
  try {
    RTCAudioSession?.setManualAudio(enabled);
  } catch (error) {
    console.warn('nativeCallService: RTCAudioSession.setManualAudio failed', error);
  }
};

const setWebRtcAudioEnabled = (enabled: boolean): void => {
  try {
    RTCAudioSession?.setAudioEnabled(enabled);
  } catch (error) {
    console.warn('nativeCallService: RTCAudioSession.setAudioEnabled failed', error);
  }
};

const handleAudioSessionActivated = (source: 'live' | 'buffered') => {
  audioSessionActivated = true;
  // A genuine CallKit activation means CallKit now owns deactivation — even if
  // the watchdog fallback already fired, CallKit's later didDeactivate will
  // tear the session down, so JS must not also deactivate it.
  audioSessionActivatedByFallback = false;
  debugLog(`nativeCallService: didActivateAudioSession (${source})`);
  RTCAudioSession?.audioSessionDidActivate();
  // Manual audio: CallKit activating the session is our cue to start the audio
  // unit. Without this the call negotiates media but stays silent.
  setWebRtcAudioEnabled(true);
};

const handleAudioSessionDeactivated = (source: 'live' | 'buffered') => {
  audioSessionActivated = false;
  audioSessionActivatedByFallback = false;
  debugLog(`nativeCallService: didDeactivateAudioSession (${source})`);
  // Manual audio: stop the audio unit BEFORE handing the session back to WebRTC
  // so it tears down against a still-valid session.
  setWebRtcAudioEnabled(false);
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
    appendCallDebug('startCall.parked', { pending: pendingStartCallEvents.length });
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
    appendCallDebug('startCall.ignored', { reason: 'blank handle' });
    return;
  }

  const nativeCallId = typeof data.callUUID === 'string' && data.callUUID.length > 0 ? data.callUUID : null;

  // Breadcrumb every raw redial event (device-only failures ship blind to
  // TestFlight — this is how we later see what CallKit actually delivered).
  appendCallDebug('startCall.received', { handle, nativeCallId, hasVideo: data.video === true });

  // CallKit echoes the app's OWN outgoing calls back through
  // didReceiveStartCallAction (RNCallKeep.startCall → CXStartCallAction →
  // provider delegate → JS). That echo is NOT a Phone-app Recents redial —
  // forwarding it would make the redial flow dismiss the live outgoing call
  // the instant it starts. Genuine Recents/Siri redials arrive with either no
  // UUID (INStartCallIntent user-activity path) or a CallKit-created
  // placeholder UUID that is never in our mapping.
  if (nativeCallId && isAppInitiatedNativeCall(nativeCallId)) {
    appendCallDebug('startCall.echoFiltered', { nativeCallId, reason: 'in-memory app-initiated uuid' });
    return;
  }

  // ECHO-FILTER FALSE-POSITIVE INVARIANT: a genuine redial can never be
  // suppressed. The INStartCallIntent path carries NO UUID (emitted
  // unconditionally just below), and the CXStartCallAction path carries a
  // random CallKit-generated placeholder UUID. Our app-initiated UUIDs are
  // deterministic uuidv5 values derived from unique app callIds, so a random
  // placeholder matches neither the in-memory map above nor the persisted set
  // below — the filter provably only eats our own echoes.
  if (!nativeCallId) {
    appendCallDebug('startCall.emit', { handle, reason: 'no-uuid INStartCallIntent redial' });
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
      appendCallDebug('startCall.echoFiltered', {
        nativeCallId,
        reason: 'persisted app-initiated uuid (previous launch)',
      });
      return;
    }
    appendCallDebug('startCall.emit', { handle, nativeCallId, reason: 'unknown uuid — genuine redial' });
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
  appToNativeCallMappedAt.set(appCallId, Date.now());
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
        // Put WebRTC into manual-audio mode ONCE, before any call: from now on
        // the audio unit starts/stops solely on CallKit's session events
        // (setAudioEnabled), never autonomously — the canonical fix for calls
        // that connect but stay silent. iOS-only + guarded, so it's a no-op on
        // Android/web and on binaries built before the native method was added.
        setWebRtcManualAudio(true);
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
  // Teardown MUST clear the activation flags. CallKit only fires
  // didDeactivateAudioSession when it deactivates cleanly; on an abnormal end
  // (peer drop, crash, force-kill) it may never fire, leaving
  // audioSessionActivated stuck `true`. The NEXT call's watchdog then sees the
  // session as already active and skips activation → silent call until restart.
  // resetAudioSession clears the flags (and, for a JS-owned session, notifies
  // WebRTC). Callers that also manage the LiveKit AudioSession (useCallManager)
  // snapshot jsOwnsAudioSession() BEFORE invoking endCall.
  resetAudioSession();
}

/**
 * Doc 31 §3.9/§5 Phase 2 — dismiss THIS device's incoming/in-progress call UI
 * because a DIFFERENT device of the same account answered it, using CallKit's
 * dedicated `.answeredElsewhere` reason (verified against Apple's own
 * CXCallEndedReason docs) rather than endCall's plain "I hung up" reason —
 * that distinction is what makes CallKit report the dismissal correctly
 * instead of looking like a local hangup/decline. Requires
 * reportNewIncomingCall to have already run for this UUID (it always has by
 * the time this fires — the call was ringing on this device); calling it for
 * a UUID CallKit doesn't know about is a silent no-op, not a crash.
 */
async function reportAnsweredElsewhere(appCallId: string): Promise<void> {
  if (!RNCallKeep) {
    return;
  }

  await initialize();
  const nativeCallId = ensureMappedNativeCallId(appCallId);
  RNCallKeep.reportEndCallWithUUID(
    nativeCallId,
    CallKeepConstants?.END_CALL_REASONS.ANSWERED_ELSEWHERE ?? 4
  );
  // Same rationale as endCall: CallKit may not fire didDeactivateAudioSession
  // on this path either — reset so the next call's watchdog doesn't see a
  // stuck "already active" flag.
  resetAudioSession();
}

/**
 * Dismisses the incoming-call UI on THIS device because the user turned
 * ringing off here (doc 31 §3.8 / decision #13) — other devices keep ringing
 * and the caller is told nothing.
 *
 * The call is still reported to CallKit first and dismissed immediately after,
 * never skipped: iOS revokes the VoIP push privilege outright if a push does
 * not report an incoming call (CLAUDE.md), so "don't ring here" has to mean
 * "report then silence", not "ignore".
 *
 * ANSWERED_ELSEWHERE is deliberate over a decline reason. A decline would tell
 * the caller this user rejected them, which is false — the account is still
 * ringing on their other devices and may well answer. This reason is purely
 * local to CallKit's own log and signals nothing to the caller.
 */
async function silenceIncomingCallHere(appCallId: string): Promise<void> {
  await reportAnsweredElsewhere(appCallId);
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

  // SAFETY (UUID separation): this only ever targets the random placeholder
  // UUID CallKit invents for a Recents CXStartCallAction — never one of our
  // deterministic app-initiated UUIDs. Guard anyway: if the UUID maps to a call
  // THIS app placed, refuse to end it, or we'd hang up the real outgoing call
  // that the redial flow is about to (re)start a moment later.
  if (isAppInitiatedNativeCall(nativeCallId)) {
    appendCallDebug('dismissNativeCall.skipped', { nativeCallId, reason: 'app-initiated uuid' });
    return;
  }

  appendCallDebug('dismissNativeCall', { nativeCallId });
  RNCallKeep.endCall(nativeCallId);
  // Same stale-flag guard as endCall: dismissing a call is a teardown path too,
  // and its CallKit deactivation may never arrive — reset so the next call can
  // activate audio. BUT only when no app-initiated call is live: dismissing a
  // Recents placeholder DURING an active call (CallContext dismisses before
  // its active-call guard) must not clear the LIVE call's activation flags —
  // for a watchdog-activated session that reset would stop the audio unit and
  // silence the in-progress call. With a call live, its own teardown
  // (endCall → resetAudioSession) owns the flag cleanup.
  // appToNativeCallIds is cleared by clearCall() on every teardown path this
  // slice knows about, but an entry left behind by one this doesn't cover
  // (crash, force-kill) would otherwise block this reset forever — size
  // alone can't tell "live call" from "stuck entry". A mapping older than
  // any plausible real call is treated as stale, not live.
  const now = Date.now();
  const hasLiveCall = [...appToNativeCallMappedAt.values()].some(
    (mappedAt) => now - mappedAt < MAX_PLAUSIBLE_CALL_DURATION_MS,
  );
  if (!hasLiveCall) {
    resetAudioSession();
  } else {
    appendCallDebug('dismissNativeCall.resetSkipped', { reason: 'app call live' });
  }
}

function clearCall(appCallId: string): void {
  const nativeCallId = appToNativeCallIds.get(appCallId);
  if (!nativeCallId) {
    return;
  }

  appToNativeCallIds.delete(appCallId);
  appToNativeCallMappedAt.delete(appCallId);
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
    appendCallDebug('startCall.replay', { count: parked.length });
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
  // Manual audio: the watchdog fallback owns activation, so it must also start
  // the audio unit — otherwise the fallback path stays silent too.
  setWebRtcAudioEnabled(true);
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
    // Manual audio: stop the audio unit before notifying WebRTC the session is
    // gone (mirrors handleAudioSessionDeactivated).
    setWebRtcAudioEnabled(false);
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
  reportAnsweredElsewhere,
  silenceIncomingCallHere,
  dismissNativeCall,
  clearCall,
  bringAppToForeground,
  subscribe,
};
