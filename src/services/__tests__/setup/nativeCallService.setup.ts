/**
 * Test setup for nativeCallService unit tests.
 *
 * nativeCallService loads react-native-callkeep and
 * @livekit/react-native-webrtc via bare `require(...)` calls at module scope
 * (so the web bundle never evaluates them). Vitest routes those through
 * Node's CJS loader (bypassing vite aliases), so we intercept Module._load
 * to return in-memory mocks. The mocks are exposed on
 * `globalThis.__nativeCallTestMocks` so tests can drive CallKeep events
 * and assert on native calls. `vi.resetModules()` resets nativeCallService's
 * module state but NOT these mocks — tests must clear them in beforeEach.
 */
import { createRequire } from 'module';
import { vi } from 'vitest';

(globalThis as Record<string, unknown>).__DEV__ = false;

export type CallKeepEventHandler = (data: any) => void;

const callKeepListeners = new Map<string, CallKeepEventHandler>();

const RNCallKeepMock = {
  addEventListener: vi.fn((eventName: string, handler: CallKeepEventHandler) => {
    callKeepListeners.set(eventName, handler);
    return { remove: vi.fn() };
  }),
  removeEventListener: vi.fn(),
  setup: vi.fn(async () => true),
  setReachable: vi.fn(),
  setAvailable: vi.fn(),
  getInitialEvents: vi.fn(async () => [] as Array<{ name: string; data: any }>),
  clearInitialEvents: vi.fn(),
  startCall: vi.fn(),
  endCall: vi.fn(),
  displayIncomingCall: vi.fn(),
  answerIncomingCall: vi.fn(),
  rejectCall: vi.fn(),
  reportConnectedOutgoingCallWithUUID: vi.fn(),
};

const callKeepModuleMock = {
  default: RNCallKeepMock,
  AudioSessionCategoryOption: {
    allowBluetooth: 1,
    allowBluetoothA2DP: 2,
    allowAirPlay: 4,
  },
  AudioSessionMode: {
    voiceChat: 'voiceChat',
  },
};

const RTCAudioSessionMock = {
  audioSessionDidActivate: vi.fn(),
  audioSessionDidDeactivate: vi.fn(),
  // WebRTC manual-audio bridge (patched into @livekit/react-native-webrtc):
  // nativeCallService toggles these on CallKit activation/teardown.
  setManualAudio: vi.fn(),
  setAudioEnabled: vi.fn(),
};

(globalThis as Record<string, unknown>).__nativeCallTestMocks = {
  RNCallKeep: RNCallKeepMock,
  callKeepListeners,
  RTCAudioSession: RTCAudioSessionMock,
  // Backing store for the @react-native-async-storage/async-storage mock
  // (aliased in vitest.services.config.ts). Created here so it exists before
  // the first beforeEach, even if no test has imported the service yet.
  asyncStorageStore: new Map<string, string>(),
};

const webrtcModuleMock = { RTCAudioSession: RTCAudioSessionMock };

// Intercept Node's CJS loader so any require() of these native-only packages
// (from any module, however vitest wires `require`) returns the mocks.
const nodeRequire = createRequire(import.meta.url);
const ModuleCtor = nodeRequire('module') as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = ModuleCtor._load;
ModuleCtor._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === 'react-native-callkeep') {
    return callKeepModuleMock;
  }
  if (request === '@livekit/react-native-webrtc') {
    return webrtcModuleMock;
  }
  return originalLoad.call(this, request, parent, isMain);
};

// Fallback for environments where the transformed code resolves a bare
// `require` identifier against the global scope instead of Node's loader.
(globalThis as Record<string, unknown>).require = (moduleName: string) => {
  if (moduleName === 'react-native-callkeep') {
    return callKeepModuleMock;
  }
  if (moduleName === '@livekit/react-native-webrtc') {
    return webrtcModuleMock;
  }
  return nodeRequire(moduleName);
};
