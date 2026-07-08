/**
 * Regression tests for nativeCallService's CallKit event filtering.
 *
 * The critical invariant: CallKit echoes the app's OWN outgoing calls back
 * through didReceiveStartCallAction. If that echo is ever forwarded to the
 * redial flow, the redial handler dismisses the live outgoing call the
 * instant it starts (the "call hangs itself up" bug). These tests pin the
 * filtering behavior for both the live-listener path and the buffered
 * (didLoadWithEvents / getInitialEvents) path, so a regression fails at
 * commit time instead of on a physical iPhone via TestFlight.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Mocks = {
  RNCallKeep: {
    addEventListener: ReturnType<typeof vi.fn>;
    setup: ReturnType<typeof vi.fn>;
    getInitialEvents: ReturnType<typeof vi.fn>;
    clearInitialEvents: ReturnType<typeof vi.fn>;
    startCall: ReturnType<typeof vi.fn>;
    endCall: ReturnType<typeof vi.fn>;
    setReachable: ReturnType<typeof vi.fn>;
    [key: string]: ReturnType<typeof vi.fn>;
  };
  callKeepListeners: Map<string, (data: any) => void>;
  RTCAudioSession: {
    audioSessionDidActivate: ReturnType<typeof vi.fn>;
    audioSessionDidDeactivate: ReturnType<typeof vi.fn>;
  };
  asyncStorageStore: Map<string, string>;
};

const mocks = (globalThis as Record<string, unknown>).__nativeCallTestMocks as Mocks;

/**
 * Redial emits with an unrecognized UUID are deferred behind an async read of
 * the crash-safe persisted outgoing-call record (see emitStartCall). Flush
 * pending microtasks so those deferred emits land before assertions run.
 */
const flushAsyncEmits = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const fireCallKeepEvent = (eventName: string, data: unknown) => {
  const handler = mocks.callKeepListeners.get(eventName);
  if (!handler) {
    throw new Error(`No CallKeep listener bound for ${eventName}`);
  }
  handler(data);
};

type ServiceModule = typeof import('../nativeCallService');

/** Fresh nativeCallService module (module-level state fully reset). */
const loadService = async (): Promise<ServiceModule> => {
  vi.resetModules();
  return import('../nativeCallService');
};

const initializedService = async (): Promise<ServiceModule> => {
  const mod = await loadService();
  await mod.nativeCallService.initialize();
  return mod;
};

beforeEach(() => {
  mocks.callKeepListeners.clear();
  for (const value of Object.values(mocks.RNCallKeep)) {
    if (typeof value === 'function' && 'mockClear' in value) {
      (value as ReturnType<typeof vi.fn>).mockClear();
    }
  }
  mocks.RNCallKeep.setup.mockImplementation(async () => true);
  mocks.RNCallKeep.getInitialEvents.mockImplementation(async () => []);
  mocks.RTCAudioSession.audioSessionDidActivate.mockClear();
  mocks.RTCAudioSession.audioSessionDidDeactivate.mockClear();
  mocks.asyncStorageStore.clear();
});

describe('nativeUuidForCall', () => {
  it('derives a deterministic lowercase RFC-4122 uuid from an app callId', async () => {
    const { nativeUuidForCall } = await loadService();
    const first = nativeUuidForCall('call_12345');
    const second = nativeUuidForCall('call_12345');
    expect(first).toBe(second);
    expect(first).toBe(first.toLowerCase());
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(nativeUuidForCall('call_other')).not.toBe(first);
  });
});

describe('start-call echo filtering (live listener path)', () => {
  it('drops the CallKit echo of a call started via startOutgoingCall', async () => {
    const { nativeCallService, nativeUuidForCall } = await initializedService();
    const onStartCall = vi.fn();
    nativeCallService.subscribe('startCall', onStartCall);

    await nativeCallService.startOutgoingCall('call_abc', 'peer-user-1', 'Peer', false);
    const nativeCallId = nativeUuidForCall('call_abc');
    expect(mocks.RNCallKeep.startCall).toHaveBeenCalledWith(
      nativeCallId,
      'peer-user-1',
      'Peer',
      'generic',
      false
    );

    fireCallKeepEvent('didReceiveStartCallAction', {
      handle: 'peer-user-1',
      callUUID: nativeCallId,
      video: false,
    });
    await flushAsyncEmits();

    expect(onStartCall).not.toHaveBeenCalled();
  });

  it('matches the echo UUID case-insensitively (iOS NSUUID uppercases)', async () => {
    const { nativeCallService, nativeUuidForCall } = await initializedService();
    const onStartCall = vi.fn();
    nativeCallService.subscribe('startCall', onStartCall);

    await nativeCallService.startOutgoingCall('call_case', 'peer-user-2', 'Peer', true);

    fireCallKeepEvent('didReceiveStartCallAction', {
      handle: 'peer-user-2',
      callUUID: nativeUuidForCall('call_case').toUpperCase(),
      video: true,
    });
    await flushAsyncEmits();

    expect(onStartCall).not.toHaveBeenCalled();
  });

  it('emits a genuine Recents redial that has no callUUID', async () => {
    const { nativeCallService } = await initializedService();
    const onStartCall = vi.fn();
    nativeCallService.subscribe('startCall', onStartCall);

    fireCallKeepEvent('didReceiveStartCallAction', {
      handle: 'peer-user-3',
      video: false,
    });

    expect(onStartCall).toHaveBeenCalledTimes(1);
    expect(onStartCall).toHaveBeenCalledWith({
      handle: 'peer-user-3',
      nativeCallId: null,
      hasVideo: false,
    });
  });

  it('emits a redial whose CallKit placeholder UUID is not in the app mapping', async () => {
    const { nativeCallService } = await initializedService();
    const onStartCall = vi.fn();
    nativeCallService.subscribe('startCall', onStartCall);

    await nativeCallService.startOutgoingCall('call_live', 'peer-user-4', 'Peer', false);

    const placeholderUuid = '11111111-2222-3333-4444-555555555555';
    fireCallKeepEvent('didReceiveStartCallAction', {
      handle: 'peer-user-4',
      callUUID: placeholderUuid,
      video: true,
    });
    await flushAsyncEmits();

    expect(onStartCall).toHaveBeenCalledTimes(1);
    expect(onStartCall).toHaveBeenCalledWith({
      handle: 'peer-user-4',
      nativeCallId: placeholderUuid,
      hasVideo: true,
    });
  });

  it('ignores start-call events with a blank handle', async () => {
    const { nativeCallService } = await initializedService();
    const onStartCall = vi.fn();
    nativeCallService.subscribe('startCall', onStartCall);

    fireCallKeepEvent('didReceiveStartCallAction', { handle: '   ', video: false });
    fireCallKeepEvent('didReceiveStartCallAction', { video: false });

    expect(onStartCall).not.toHaveBeenCalled();
  });
});

describe('start-call echo filtering (buffered paths)', () => {
  it('drops a buffered echo delivered via didLoadWithEvents, even with no subscriber yet', async () => {
    const { nativeCallService, nativeUuidForCall } = await initializedService();

    await nativeCallService.startOutgoingCall('call_buf', 'peer-user-5', 'Peer', false);

    fireCallKeepEvent('didLoadWithEvents', [
      {
        name: 'RNCallKeepDidReceiveStartCallAction',
        data: {
          handle: 'peer-user-5',
          callUUID: nativeUuidForCall('call_buf'),
          video: false,
        },
      },
    ]);

    await flushAsyncEmits();

    // Subscribe AFTER the buffered delivery: a dropped echo must not have
    // been parked for replay either.
    const onStartCall = vi.fn();
    nativeCallService.subscribe('startCall', onStartCall);
    expect(onStartCall).not.toHaveBeenCalled();
  });

  it('drops a buffered echo with an uppercased UUID', async () => {
    const { nativeCallService, nativeUuidForCall } = await initializedService();
    const onStartCall = vi.fn();
    nativeCallService.subscribe('startCall', onStartCall);

    await nativeCallService.startOutgoingCall('call_buf_case', 'peer-user-6', 'Peer', true);

    fireCallKeepEvent('didLoadWithEvents', [
      {
        name: 'RNCallKeepDidReceiveStartCallAction',
        data: {
          handle: 'peer-user-6',
          callUUID: nativeUuidForCall('call_buf_case').toUpperCase(),
          video: true,
        },
      },
    ]);
    await flushAsyncEmits();

    expect(onStartCall).not.toHaveBeenCalled();
  });

  it('parks a buffered cold-start redial (getInitialEvents) and replays it on subscribe', async () => {
    mocks.RNCallKeep.getInitialEvents.mockImplementation(async () => [
      {
        name: 'RNCallKeepDidReceiveStartCallAction',
        data: {
          handle: 'peer-user-7',
          callUUID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          video: false,
        },
      },
    ]);

    const { nativeCallService } = await loadService();
    await nativeCallService.initialize();

    // No subscriber existed during the flush — the event must be parked.
    const onStartCall = vi.fn();
    nativeCallService.subscribe('startCall', onStartCall);

    expect(onStartCall).toHaveBeenCalledTimes(1);
    expect(onStartCall).toHaveBeenCalledWith({
      handle: 'peer-user-7',
      nativeCallId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      hasVideo: false,
    });

    // Parked events replay exactly once — a second subscriber gets nothing.
    const secondSubscriber = vi.fn();
    nativeCallService.subscribe('startCall', secondSubscriber);
    expect(secondSubscriber).not.toHaveBeenCalled();
  });

  it('parks a live redial that fires before any subscriber and replays it on subscribe', async () => {
    const { nativeCallService } = await initializedService();

    fireCallKeepEvent('didReceiveStartCallAction', {
      handle: 'peer-user-8',
      video: true,
    });

    const onStartCall = vi.fn();
    nativeCallService.subscribe('startCall', onStartCall);

    expect(onStartCall).toHaveBeenCalledTimes(1);
    expect(onStartCall).toHaveBeenCalledWith({
      handle: 'peer-user-8',
      nativeCallId: null,
      hasVideo: true,
    });
  });

  it('dedupes an identical buffered redial delivered twice', async () => {
    const { nativeCallService } = await initializedService();
    const onStartCall = vi.fn();
    nativeCallService.subscribe('startCall', onStartCall);

    const bufferedEvent = {
      name: 'RNCallKeepDidReceiveStartCallAction',
      data: {
        handle: 'peer-user-9',
        callUUID: '99999999-8888-7777-6666-555555555555',
        video: false,
      },
    };

    fireCallKeepEvent('didLoadWithEvents', [bufferedEvent]);
    fireCallKeepEvent('didLoadWithEvents', [bufferedEvent]);
    await flushAsyncEmits();

    expect(onStartCall).toHaveBeenCalledTimes(1);
  });
});

describe('force-kill right after dialing (crash-safe persisted echo filtering)', () => {
  /**
   * Simulates: place a call → process dies immediately (force-kill) → next
   * launch receives CallKit's buffered echo of that same call. The relaunch
   * is modeled by loading a FRESH module (empty in-memory UUID maps) while
   * the AsyncStorage mock's backing store survives, exactly like on-device.
   */
  it('persists the outgoing UUID to storage BEFORE RNCallKeep.startCall fires', async () => {
    const callOrder: string[] = [];
    const { __asyncStorageStore } = await import('./mocks/async-storage');
    mocks.RNCallKeep.startCall.mockImplementation(() => {
      callOrder.push(
        __asyncStorageStore.has('nativeCallService.recentOutgoingNativeCallIds')
          ? 'startCall:persisted'
          : 'startCall:NOT-persisted'
      );
    });

    const { nativeCallService } = await initializedService();
    await nativeCallService.startOutgoingCall('call_crash_order', 'peer-user-10', 'Peer', false);

    expect(callOrder).toEqual(['startCall:persisted']);
  });

  it('does NOT auto-place a phantom call when the buffered echo arrives on the next launch', async () => {
    // Launch 1: place a call. The app "dies" right after (no cleanup runs).
    const firstLaunch = await initializedService();
    await firstLaunch.nativeCallService.startOutgoingCall('call_killed', 'peer-user-11', 'Peer', false);
    const nativeCallId = firstLaunch.nativeUuidForCall('call_killed');

    // Launch 2: fresh process — in-memory maps are empty, CallKit delivers
    // the echo of the killed call as a buffered cold-start event.
    mocks.callKeepListeners.clear();
    mocks.RNCallKeep.getInitialEvents.mockImplementation(async () => [
      {
        name: 'RNCallKeepDidReceiveStartCallAction',
        data: { handle: 'peer-user-11', callUUID: nativeCallId, video: false },
      },
    ]);
    const secondLaunch = await loadService();
    await secondLaunch.nativeCallService.initialize();
    await flushAsyncEmits();

    // The echo must be dropped: not emitted live, and not parked for replay.
    const onStartCall = vi.fn();
    secondLaunch.nativeCallService.subscribe('startCall', onStartCall);
    await flushAsyncEmits();
    expect(onStartCall).not.toHaveBeenCalled();
  });

  it('drops the persisted echo even when iOS uppercases the buffered UUID', async () => {
    const firstLaunch = await initializedService();
    await firstLaunch.nativeCallService.startOutgoingCall('call_killed_case', 'peer-user-12', 'Peer', true);
    const nativeCallId = firstLaunch.nativeUuidForCall('call_killed_case');

    mocks.callKeepListeners.clear();
    mocks.RNCallKeep.getInitialEvents.mockImplementation(async () => [
      {
        name: 'RNCallKeepDidReceiveStartCallAction',
        data: { handle: 'peer-user-12', callUUID: nativeCallId.toUpperCase(), video: true },
      },
    ]);
    const secondLaunch = await loadService();
    await secondLaunch.nativeCallService.initialize();
    await flushAsyncEmits();

    const onStartCall = vi.fn();
    secondLaunch.nativeCallService.subscribe('startCall', onStartCall);
    await flushAsyncEmits();
    expect(onStartCall).not.toHaveBeenCalled();
  });

  it('still emits a genuine Recents redial on the relaunch after a force-kill', async () => {
    // Launch 1: place a call, die.
    const firstLaunch = await initializedService();
    await firstLaunch.nativeCallService.startOutgoingCall('call_killed_2', 'peer-user-13', 'Peer', false);

    // Launch 2: the user taps a Recents entry — CallKit creates a random
    // placeholder UUID that was never one of ours. It must NOT be suppressed.
    mocks.callKeepListeners.clear();
    const redialUuid = 'deadbeef-0000-4000-8000-000000000001';
    mocks.RNCallKeep.getInitialEvents.mockImplementation(async () => [
      {
        name: 'RNCallKeepDidReceiveStartCallAction',
        data: { handle: 'peer-user-13', callUUID: redialUuid, video: false },
      },
    ]);
    const secondLaunch = await loadService();
    await secondLaunch.nativeCallService.initialize();
    await flushAsyncEmits();

    const onStartCall = vi.fn();
    secondLaunch.nativeCallService.subscribe('startCall', onStartCall);
    await flushAsyncEmits();
    expect(onStartCall).toHaveBeenCalledTimes(1);
    expect(onStartCall).toHaveBeenCalledWith({
      handle: 'peer-user-13',
      nativeCallId: redialUuid,
      hasVideo: false,
    });
  });

  it('expires persisted UUIDs after the TTL so stale entries cannot mask far-future events', async () => {
    const { __asyncStorageStore } = await import('./mocks/async-storage');
    const staleUuid = 'aaaa1111-bbbb-4ccc-8ddd-eeee22223333';
    __asyncStorageStore.set(
      'nativeCallService.recentOutgoingNativeCallIds',
      JSON.stringify([{ nativeCallId: staleUuid, at: Date.now() - 11 * 60 * 1000 }])
    );

    mocks.RNCallKeep.getInitialEvents.mockImplementation(async () => [
      {
        name: 'RNCallKeepDidReceiveStartCallAction',
        data: { handle: 'peer-user-14', callUUID: staleUuid, video: false },
      },
    ]);
    const { nativeCallService } = await loadService();
    await nativeCallService.initialize();
    await flushAsyncEmits();

    const onStartCall = vi.fn();
    nativeCallService.subscribe('startCall', onStartCall);
    await flushAsyncEmits();
    expect(onStartCall).toHaveBeenCalledTimes(1);
  });

  it('survives corrupted persisted storage without suppressing redials or crashing', async () => {
    const { __asyncStorageStore } = await import('./mocks/async-storage');
    __asyncStorageStore.set('nativeCallService.recentOutgoingNativeCallIds', '{not-json!');

    mocks.RNCallKeep.getInitialEvents.mockImplementation(async () => [
      {
        name: 'RNCallKeepDidReceiveStartCallAction',
        data: {
          handle: 'peer-user-15',
          callUUID: 'cccc1111-dddd-4eee-8fff-aaaa22223333',
          video: false,
        },
      },
    ]);
    const { nativeCallService } = await loadService();
    await nativeCallService.initialize();
    await flushAsyncEmits();

    const onStartCall = vi.fn();
    nativeCallService.subscribe('startCall', onStartCall);
    await flushAsyncEmits();
    expect(onStartCall).toHaveBeenCalledTimes(1);
  });

  it('normal same-session outgoing call still works and its echo is dropped by the in-memory map', async () => {
    const { nativeCallService, nativeUuidForCall } = await initializedService();
    const onStartCall = vi.fn();
    nativeCallService.subscribe('startCall', onStartCall);

    await nativeCallService.startOutgoingCall('call_normal', 'peer-user-16', 'Peer', false);
    expect(mocks.RNCallKeep.startCall).toHaveBeenCalledTimes(1);

    fireCallKeepEvent('didReceiveStartCallAction', {
      handle: 'peer-user-16',
      callUUID: nativeUuidForCall('call_normal'),
      video: false,
    });
    await flushAsyncEmits();

    expect(onStartCall).not.toHaveBeenCalled();
  });
});

describe('answer/end/mute mapping lookups are unaffected by echo filtering', () => {
  it('maps answer events for an app-initiated call to its appCallId', async () => {
    const { nativeCallService, nativeUuidForCall } = await initializedService();
    const onAnswer = vi.fn();
    nativeCallService.subscribe('answer', onAnswer);

    await nativeCallService.startOutgoingCall('call_ans', 'peer', 'Peer', false);
    const nativeCallId = nativeUuidForCall('call_ans');

    fireCallKeepEvent('answerCall', { callUUID: nativeCallId });

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({
      appCallId: 'call_ans',
      nativeCallId,
    });
  });

  it('still emits end events for an app-initiated (registered) UUID', async () => {
    const { nativeCallService, nativeUuidForCall } = await initializedService();
    const onEnd = vi.fn();
    nativeCallService.subscribe('end', onEnd);

    await nativeCallService.startOutgoingCall('call_end', 'peer', 'Peer', false);
    const nativeCallId = nativeUuidForCall('call_end');

    fireCallKeepEvent('endCall', { callUUID: nativeCallId });

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith({
      appCallId: 'call_end',
      nativeCallId,
    });
  });

  it('emits end events with a null appCallId for unknown UUIDs', async () => {
    const { nativeCallService } = await initializedService();
    const onEnd = vi.fn();
    nativeCallService.subscribe('end', onEnd);

    fireCallKeepEvent('endCall', { callUUID: 'deadbeef-0000-1111-2222-333333333333' });

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith({
      appCallId: null,
      nativeCallId: 'deadbeef-0000-1111-2222-333333333333',
    });
  });

  it('maps mute events and preserves the muted flag', async () => {
    const { nativeCallService, nativeUuidForCall } = await initializedService();
    const onMute = vi.fn();
    nativeCallService.subscribe('mute', onMute);

    await nativeCallService.startOutgoingCall('call_mute', 'peer', 'Peer', false);
    const nativeCallId = nativeUuidForCall('call_mute');

    fireCallKeepEvent('didPerformSetMutedCallAction', { callUUID: nativeCallId, muted: true });
    fireCallKeepEvent('didPerformSetMutedCallAction', { callUUID: nativeCallId, muted: false });

    expect(onMute).toHaveBeenNthCalledWith(1, {
      appCallId: 'call_mute',
      nativeCallId,
      muted: true,
    });
    expect(onMute).toHaveBeenNthCalledWith(2, {
      appCallId: 'call_mute',
      nativeCallId,
      muted: false,
    });
  });

  it('maps buffered answer/end events through the same lookup', async () => {
    const { nativeCallService, nativeUuidForCall } = await initializedService();
    const onAnswer = vi.fn();
    const onEnd = vi.fn();
    nativeCallService.subscribe('answer', onAnswer);
    nativeCallService.subscribe('end', onEnd);

    await nativeCallService.startOutgoingCall('call_buf_ans', 'peer', 'Peer', false);
    const nativeCallId = nativeUuidForCall('call_buf_ans');

    fireCallKeepEvent('didLoadWithEvents', [
      { name: 'RNCallKeepPerformAnswerCallAction', data: { callUUID: nativeCallId } },
      { name: 'RNCallKeepPerformEndCallAction', data: { callUUID: nativeCallId } },
    ]);

    expect(onAnswer).toHaveBeenCalledWith({ appCallId: 'call_buf_ans', nativeCallId });
    expect(onEnd).toHaveBeenCalledWith({ appCallId: 'call_buf_ans', nativeCallId });
  });

  it('clearCall removes the mapping so later events resolve to null appCallId', async () => {
    const { nativeCallService, nativeUuidForCall } = await initializedService();
    const onEnd = vi.fn();
    nativeCallService.subscribe('end', onEnd);

    await nativeCallService.startOutgoingCall('call_clear', 'peer', 'Peer', false);
    const nativeCallId = nativeUuidForCall('call_clear');
    nativeCallService.clearCall('call_clear');

    fireCallKeepEvent('endCall', { callUUID: nativeCallId });

    expect(onEnd).toHaveBeenCalledWith({ appCallId: null, nativeCallId });
    expect(nativeCallService.isAppInitiatedNativeCall(nativeCallId)).toBe(false);
  });
});

describe('isAppInitiatedNativeCall', () => {
  it('recognizes registered UUIDs in any casing and rejects unknown ones', async () => {
    const { nativeCallService, nativeUuidForCall } = await initializedService();

    await nativeCallService.startOutgoingCall('call_reg', 'peer', 'Peer', false);
    const nativeCallId = nativeUuidForCall('call_reg');

    expect(nativeCallService.isAppInitiatedNativeCall(nativeCallId)).toBe(true);
    expect(nativeCallService.isAppInitiatedNativeCall(nativeCallId.toUpperCase())).toBe(true);
    expect(
      nativeCallService.isAppInitiatedNativeCall('00000000-0000-4000-8000-000000000000')
    ).toBe(false);
  });
});
