import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import type { CallStatus, CallType } from '@/models';
import {
  createCallSession,
  getCallSession,
  joinCall,
  leaveCall,
  subscribeToActiveCall,
  subscribeToCallSession
} from '@/services/callService';
import { LiveKitService } from '@/services/LiveKitService';
import { saveCallToHistory, type CallHistoryEntry } from '@/services/localCallStorage';
import { nativeCallService } from '@/services/nativeCallService';
import { requestCallPermissions } from '@/utils/permissions';
import { resolveDisplayName } from '@/utils/identity';
import { AudioSession } from '@livekit/react-native';
import { getApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useCallback, useEffect, useRef, useState } from 'react';

const debugLog = (...args: unknown[]) => {
  if (__DEV__) {
    console.log(...args);
  }
};

// How long an OUTGOING call rings before we give up and end it. Without this,
// an unanswered call stays "ringing" forever — orphaning the RTDB node and
// ghost-ringing the callee. Slightly longer than CallKit's own ~40s window.
const RING_TIMEOUT_MS = 45 * 1000;

// Make Bluetooth accessories (Ray-Ban Meta glasses, AirPods, car kits) eligible
// AND preferred for call audio. LiveKit's `defaultOutput` is only the fallback
// used when no headset/bluetooth output is connected, so as long as the audio
// category permits bluetooth, a connected accessory wins automatically. We keep
// `defaultToSpeaker` for video (FaceTime-style speaker when nothing is paired)
// and drop it for audio (earpiece fallback). Best-effort: if CallKit owns the
// session this may no-op, and RNCallKeep's own config already allows bluetooth.
const preferBluetoothAudio = async (isVideo: boolean): Promise<void> => {
  try {
    await AudioSession.setAppleAudioConfiguration({
      audioCategoryOptions: isVideo
        ? ['allowBluetooth', 'allowBluetoothA2DP', 'allowAirPlay', 'defaultToSpeaker']
        : ['allowBluetooth', 'allowBluetoothA2DP', 'allowAirPlay'],
      // Mode matters as much as the options: videoChat mode routes to the
      // built-in speaker by itself, voiceChat to the earpiece. Keep them in
      // lockstep with the options so audio calls actually land on the
      // earpiece after CallKit activates with the (speaker-less) setup config.
      audioMode: isVideo ? 'videoChat' : 'voiceChat',
    });
  } catch (err) {
    console.warn('useCallManager: setAppleAudioConfiguration failed', err);
  }
};

// How long to wait for CallKit's provider:didActivateAudioSession before
// concluding it will never come and activating the session from JS instead.
const AUDIO_ACTIVATION_WATCHDOG_MS = 3000;

interface UseCallManagerArgs {
  chatId?: string;
  groupId?: string;
}

interface UseCallManagerReturn {
  status: CallStatus;
  callId: string | null;
  error: string | null;
  isMuted: boolean;
  isCameraOff: boolean;
  serverUrl: string | null;
  token: string | null;
  callType: CallType;
  /** Caller-side: callee's device is reachable and ringing (vs. 'calling'). */
  remoteRinging: boolean;
  /** Caller-side: the outgoing call timed out with no answer. */
  noAnswer: boolean;
  startCall: (callType?: CallType) => Promise<void>;
  joinExistingCall: (callId: string) => Promise<void>;
  endCall: () => Promise<void>;
  toggleMute: () => void;
  toggleCamera: () => void;
}

export const useCallManager = ({ chatId, groupId }: UseCallManagerArgs): UseCallManagerReturn => {
  const { user } = useAuth();
  const { threads, sendMessage } = useChat();
  const [status, setStatus] = useState<CallStatus>('idle');
  const [callId, setCallId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [callType, setCallType] = useState<CallType>('video');
  // Caller-side: true once the callee's device is confirmed reachable ('ringing'
  // vs 'calling'). And true once an outgoing call has timed out unanswered.
  const [remoteRinging, setRemoteRinging] = useState(false);
  const [noAnswer, setNoAnswer] = useState(false);

  // LiveKit connection details
  const [token, setToken] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);

  const callIdRef = useRef<string | null>(null);
  const callStartedAtRef = useRef<number | null>(null);
  const connectedAtRef = useRef<number | null>(null);
  const otherParticipantRef = useRef<{ userId: string; displayName: string; photoURL?: string } | null>(null);
  const isInitiatorRef = useRef<boolean>(false);
  const hasSessionToCleanupRef = useRef(false);
  const allowUnmountCleanupRef = useRef(false);
  const sessionVersionRef = useRef(0);
  const isEndingRef = useRef(false);
  const nativeDirectionRef = useRef<'incoming' | 'outgoing'>('outgoing');
  const hasReportedConnectedNativeRef = useRef(false);
  const endCallRef = useRef<(reason?: 'manual' | 'session-ended' | 'unmount' | 'no-answer') => Promise<void>>(async () => undefined);
  // Debounce rapid duplicate starts (double-taps / effect re-fires) so a single
  // intent can't spawn several "ringing" call nodes in a burst.
  const lastStartAtRef = useRef(0);
  const unsubscribes = useRef<Array<() => void>>([]);
  const audioWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoModeReapplyRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup subscriptions
  const cleanupSubscriptions = useCallback(() => {
    debugLog('useCallManager cleanup subscriptions');
    unsubscribes.current.forEach((unsub) => unsub());
    unsubscribes.current = [];
  }, []);

  // NOTE: the handle we report here is exactly what iOS hands back on a
  // Recents redial (CallContext.resolveRedialThread). For DIRECT calls the
  // peer's userId is unambiguous. For GROUP calls a member userId is NOT — the
  // member can belong to several groups — so report the group's chatId as the
  // handle instead; the redial resolver matches chatId first, making group
  // redials deterministic. Display name is unaffected (CallKit shows
  // localizedCallerName, not the handle).
  const buildNativeHandle = useCallback((
    fallbackDisplayName?: string,
    fallbackUserId?: string,
  ) => {
    const thread = threads.find((item) => item.chatId === chatId);
    const isGroup = thread?.type === 'group';
    const directParticipant = thread?.participants.find((participant) => participant.userId !== user?.userId);
    const displayName = resolveDisplayName(
      directParticipant,
      fallbackDisplayName || (isGroup ? 'Group Call' : 'SplitCircle Contact'),
    );
    const handle = isGroup
      ? (chatId || displayName)
      : (directParticipant?.userId || fallbackUserId || chatId || displayName);

    return {
      displayName,
      handle,
    };
  }, [chatId, threads, user?.userId]);

  // CallKit activates the AVAudioSession with the (speaker-less, voiceChat)
  // setup config, so a VIDEO call — especially one answered from the lock
  // screen — can get stuck in voiceChat mode on the earpiece. Once activation
  // is actually in effect (CallKit's event OR the JS watchdog fallback),
  // re-apply videoChat mode + the speaker route. Polling for activation first
  // guarantees we never fight CallKit mid-negotiation. Bails after 5s so a
  // never-activated session can't leak the interval.
  const reapplyVideoAudioModeAfterActivation = useCallback(() => {
    if (!nativeCallService.managesAudioSession()) {
      return;
    }
    if (videoModeReapplyRef.current) {
      clearInterval(videoModeReapplyRef.current);
      videoModeReapplyRef.current = null;
    }
    const startedAt = Date.now();
    const stop = () => {
      if (videoModeReapplyRef.current) {
        clearInterval(videoModeReapplyRef.current);
        videoModeReapplyRef.current = null;
      }
    };
    videoModeReapplyRef.current = setInterval(() => {
      if (!nativeCallService.hasActivatedAudioSession()) {
        if (Date.now() - startedAt > 5000) {
          stop();
        }
        return;
      }
      stop();
      void preferBluetoothAudio(true).catch((err) =>
        console.warn('useCallManager: reapply video audio mode failed', err),
      );
    }, 250);
  }, []);

  // Configure call audio for the platform. On iOS with CallKit, the session
  // is activated by CallKit itself (provider:didActivateAudioSession →
  // RTCAudioSession.audioSessionDidActivate). Activating from JS here races
  // that activation — Apple explicitly forbids it — and can leave WebRTC's
  // audio unit wired to a dead session: a silent call. So with CallKit we
  // only configure, and arm a watchdog that activates manually iff CallKit's
  // activation never arrives. On Android (no CallKit) we activate directly.
  const setupCallAudio = useCallback(async (isVideo: boolean) => {
    await AudioSession.configureAudio({
      ios: { defaultOutput: isVideo ? 'speaker' : 'earpiece' },
    });
    if (nativeCallService.managesAudioSession()) {
      if (audioWatchdogRef.current) {
        clearTimeout(audioWatchdogRef.current);
      }
      audioWatchdogRef.current = setTimeout(() => {
        audioWatchdogRef.current = null;
        if (nativeCallService.hasActivatedAudioSession()) {
          return;
        }
        console.warn('useCallManager: CallKit never activated the audio session — activating manually');
        AudioSession.startAudioSession()
          .then(() => {
            // CRITICAL: startAudioSession() alone leaves WebRTC's audio unit
            // wired to a session it believes is inactive — a silent call.
            // Notify the WebRTC layer (RTCAudioSession.audioSessionDidActivate)
            // so the audio unit actually starts. Idempotent no-op if CallKit
            // activated in the meantime.
            nativeCallService.activateAudioSessionFallback();
            return preferBluetoothAudio(isVideo);
          })
          .catch((err) => console.warn('useCallManager: fallback startAudioSession failed', err));
      }, AUDIO_ACTIVATION_WATCHDOG_MS);
      await preferBluetoothAudio(isVideo);
      // Video: re-apply videoChat/speaker AFTER activation (see helper).
      if (isVideo) {
        reapplyVideoAudioModeAfterActivation();
      }
    } else {
      await AudioSession.startAudioSession();
      await preferBluetoothAudio(isVideo);
    }
  }, [reapplyVideoAudioModeAfterActivation]);

  // Start a new call (as initiator)
  const startCall = useCallback(async (type: CallType = 'video') => {
    if (!chatId || !user) {
      console.error('Cannot start call: missing chat or user');
      setError('Missing chat ID or user');
      return;
    }

    const nowTs = Date.now();
    if (nowTs - lastStartAtRef.current < 3000) {
      debugLog('startCall ignored: duplicate start within debounce window');
      return;
    }
    lastStartAtRef.current = nowTs;

    const sessionVersion = ++sessionVersionRef.current;

    try {
      let newCallId: string | null = null;
      cleanupSubscriptions();
      isEndingRef.current = false;
      setError(null);
      setNoAnswer(false);
      setRemoteRinging(false);
      setStatus('ringing'); // UI shows "Calling..."
      setCallType(type);
      hasReportedConnectedNativeRef.current = false;
      isInitiatorRef.current = true;
      nativeDirectionRef.current = 'outgoing';
      callStartedAtRef.current = Date.now();

      const hasPermissions = await requestCallPermissions(type);
      if (!hasPermissions) {
        throw new Error(
          type === 'video'
            ? 'Camera and microphone permissions are required for video calls.'
            : 'Microphone permission is required for audio calls.'
        );
      }

      const thread = threads.find((t) => t.chatId === chatId);
      const threadParticipantIds = thread?.participantIds ?? [user.userId];

      // Resolve other participant from thread immediately so call history is never "Unknown"
      const otherP = thread?.participants.find((p) => p.userId !== user.userId);
      if (otherP) {
        otherParticipantRef.current = {
          userId: otherP.userId,
          // otherP.displayName can be a real '' (doc 30) — guard it here, not
          // just downstream in buildNativeHandle, since this ref also feeds
          // saveCallToHistory directly (see endCall below).
          displayName: resolveDisplayName(otherP, 'Unknown'),
          photoURL: otherP.photoURL,
        };
      }

      // 1. Create Call Session in Realtime DB (Ringing)
      newCallId = await createCallSession(
        {
          chatId,
          groupId,
          userId: user.userId,
          displayName: resolveDisplayName(user, 'Unknown'),
          photoURL: user.photoURL || undefined,
          participantIds: threadParticipantIds,
        },
        type
      );

      if (sessionVersionRef.current !== sessionVersion) {
        return;
      }

      setCallId(newCallId);
      callIdRef.current = newCallId;

      // Set the WebRTC audio-session template BEFORE reporting the call to
      // CallKit — CallKit can activate the session any time after that, and
      // the template decides which category/mode it activates with.
      try {
        await AudioSession.configureAudio({
          ios: { defaultOutput: type === 'video' ? 'speaker' : 'earpiece' },
        });
      } catch (audioErr) {
        console.warn('useCallManager: configureAudio failed', audioErr);
      }

      const nativePresentation = buildNativeHandle(
        otherParticipantRef.current?.displayName,
        otherParticipantRef.current?.userId,
      );
      await nativeCallService.startOutgoingCall(
        newCallId,
        nativePresentation.handle,
        nativePresentation.displayName,
        type === 'video',
      );

      // 2. Fetch LiveKit Token
      const { token: roomToken, url } = await LiveKitService.getToken(
        newCallId,
        chatId,
        resolveDisplayName(user, 'User')
      );

      if (sessionVersionRef.current !== sessionVersion || callIdRef.current !== newCallId) {
        return;
      }

      setToken(roomToken);
      setServerUrl(url);

      // 3. Configure call audio — video defaults to speaker (FaceTime
      //    behavior), audio to earpiece. With CallKit, activation is
      //    CallKit's job; see setupCallAudio.
      try {
        await setupCallAudio(type === 'video');
      } catch (audioErr) {
        console.warn('useCallManager: call audio setup failed', audioErr);
      }

      // 4. Subscribe to Call Session to see if answered or ended
      const unsubSession = subscribeToCallSession(newCallId, (session) => {
        // Ignore stale callbacks from an older call lifecycle.
        if (sessionVersionRef.current !== sessionVersion || callIdRef.current !== newCallId) {
          return;
        }

        if (!session) {
          debugLog('useCallManager call session removed; ending call');
          void endCallRef.current('session-ended');
          return;
        }

        if (session.status === 'ended') {
          void endCallRef.current('session-ended');
          return;
        }

        // WhatsApp-style caller label: the server flips deliveryState to
        // 'ringing' once the callee's device accepts the VoIP push.
        if (session.status === 'ringing') {
          setRemoteRinging(session.deliveryState === 'ringing');
        }

        if (session.status === 'connected') {
          debugLog('useCallManager call connected');
          if (!connectedAtRef.current) {
            connectedAtRef.current = Date.now();
          }
          setStatus('connected');

          if (!hasReportedConnectedNativeRef.current) {
            hasReportedConnectedNativeRef.current = true;
            void nativeCallService.markCallConnected(newCallId, nativeDirectionRef.current);
          }

          // Only fill in other participant if not already resolved from thread
          if (!otherParticipantRef.current) {
            const other = session.participants.find(p => p.userId !== user.userId);
            if (other) {
              otherParticipantRef.current = { userId: other.userId, displayName: resolveDisplayName(other, 'Unknown'), photoURL: other.photoURL };
            }
          }
        }
      });
      unsubscribes.current.push(unsubSession);

    } catch (err) {
      if (sessionVersionRef.current !== sessionVersion) {
        return;
      }

      console.error('Error starting call', err);
      if (callIdRef.current && user) {
        try {
          await leaveCall(callIdRef.current, user.userId);
        } catch (cleanupError) {
          console.warn('Failed to cleanup failed outbound call setup', cleanupError);
        }
      }
      if (callIdRef.current) {
        await nativeCallService.endCall(callIdRef.current);
        nativeCallService.clearCall(callIdRef.current);
      }
      // Setup may have armed the activation watchdog / video-reapply poll and
      // (via the fallback) activated the session — tear all of that down so a
      // failed start can't leak a timer or leave the next call silent.
      if (audioWatchdogRef.current) {
        clearTimeout(audioWatchdogRef.current);
        audioWatchdogRef.current = null;
      }
      if (videoModeReapplyRef.current) {
        clearInterval(videoModeReapplyRef.current);
        videoModeReapplyRef.current = null;
      }
      nativeCallService.resetAudioSession();
      callIdRef.current = null;
      setCallId(null);
      setError(err instanceof Error ? err.message : 'Failed to start call');
      setStatus('failed');
    }
  }, [buildNativeHandle, chatId, groupId, threads, user, setupCallAudio]);

  // Join an existing call (as answerer)
  const joinExistingCall = useCallback(async (existingCallId: string) => {
    if (!user || !chatId) {
      console.error('Cannot join call: missing user or chat ID');
      setError('Missing authenticated user or chat ID');
      return;
    }

    const sessionVersion = ++sessionVersionRef.current;

    try {
      cleanupSubscriptions();
      isEndingRef.current = false;
      setError(null);
      setStatus('ringing');
      setCallId(existingCallId);
      callIdRef.current = existingCallId;
      hasReportedConnectedNativeRef.current = false;
      isInitiatorRef.current = false;
      nativeDirectionRef.current = 'incoming';
      callStartedAtRef.current = Date.now();

      // Resolve other participant from thread immediately as fallback
      const thread = threads.find((t) => t.chatId === chatId);
      const threadOther = thread?.participants.find((p) => p.userId !== user.userId);
      if (threadOther) {
        otherParticipantRef.current = {
          userId: threadOther.userId,
          // Same guard as startCall's mirror-image assignment above — thread
          // data can carry a real '' displayName (doc 30).
          displayName: resolveDisplayName(threadOther, 'Unknown'),
          photoURL: threadOther.photoURL,
        };
      }

      const session = await getCallSession(existingCallId);
      if (!session) {
        console.error('Call not found');
        setError('Call not found');
        setStatus('ended');
        return;
      }
      if (session.status === 'ended') {
        console.error('Call already ended');
        setError('Call already ended');
        setStatus('ended');
        return;
      }

      setCallType(session.type);

      const hasPermissions = await requestCallPermissions(session.type);
      if (!hasPermissions) {
        throw new Error(
          session.type === 'video'
            ? 'Camera and microphone permissions are required for video calls.'
            : 'Microphone permission is required for audio calls.'
        );
      }

      // Update from session if we got richer info (e.g. photoURL from initiator)
      const initiator = session.participants.find(p => p.userId === session.initiatorId);
      if (initiator) {
        otherParticipantRef.current = { userId: initiator.userId, displayName: resolveDisplayName(initiator, 'Unknown'), photoURL: initiator.photoURL };
      }

      // 1. Fetch LiveKit Token
      const { token: roomToken, url } = await LiveKitService.getToken(
        existingCallId,
        chatId,
        resolveDisplayName(user, 'User')
      );

      if (sessionVersionRef.current !== sessionVersion || callIdRef.current !== existingCallId) {
        return;
      }

      setToken(roomToken);
      setServerUrl(url);

      // 2. Configure call audio — CallKit may already have activated the
      //    AVAudioSession when the user tapped Accept on the lock screen;
      //    setupCallAudio never re-activates on iOS (that throws and could
      //    cascade into nativeCallService.endCall via the catch block below,
      //    visibly hanging up the call the moment the receiver answers).
      try {
        await setupCallAudio(session.type === 'video');
      } catch (audioErr) {
        console.warn('useCallManager: call audio setup failed', audioErr);
      }

      await nativeCallService.answerIncomingCall(existingCallId);

      // 3. Update Realtime DB (Join) - This also updates status to 'connected'
      await joinCall(existingCallId, {
        userId: user.userId,
        displayName: resolveDisplayName(user, 'Unknown'),
        muted: false,
        cameraEnabled: session.type === 'video',
      });
      debugLog('useCallManager joined call');
      connectedAtRef.current = Date.now();
      setStatus('connected'); // Immediately set to connected since we just joined
      hasReportedConnectedNativeRef.current = true;
      await nativeCallService.markCallConnected(existingCallId, nativeDirectionRef.current);

      // 4. Subscribe to session for further updates
      const unsubSession = subscribeToCallSession(existingCallId, (updatedSession) => {
        // Ignore stale callbacks from an older call lifecycle.
        if (sessionVersionRef.current !== sessionVersion || callIdRef.current !== existingCallId) {
          return;
        }

        if (!updatedSession) {
          debugLog('useCallManager joined call session removed; ending call');
          void endCallRef.current('session-ended');
          return;
        }

        if (updatedSession.status === 'ended') {
          void endCallRef.current('session-ended');
        }
      });
      unsubscribes.current.push(unsubSession);

    } catch (err) {
      console.error('Error joining call', err);
      await nativeCallService.endCall(existingCallId);
      nativeCallService.clearCall(existingCallId);
      // Setup may have armed the activation watchdog / video-reapply poll (and
      // activated the session via the fallback) before the join failed — clean
      // it up so the next call isn't left silent or leaking a timer.
      if (audioWatchdogRef.current) {
        clearTimeout(audioWatchdogRef.current);
        audioWatchdogRef.current = null;
      }
      if (videoModeReapplyRef.current) {
        clearInterval(videoModeReapplyRef.current);
        videoModeReapplyRef.current = null;
      }
      nativeCallService.resetAudioSession();
      setError(err instanceof Error ? err.message : 'Failed to join call');
      setStatus('failed');
    }
  }, [chatId, threads, user, setupCallAudio]);

  // End the call
  const endCall = useCallback(async (reason: 'manual' | 'session-ended' | 'unmount' | 'no-answer' = 'manual') => {
    if (isEndingRef.current) {
      return;
    }

    isEndingRef.current = true;
    sessionVersionRef.current += 1;
    debugLog('useCallManager ending call', reason);

    try {
      cleanupSubscriptions();
      const endingCallId = callIdRef.current;
      const endingStartedAt = callStartedAtRef.current;
      const endingConnectedAt = connectedAtRef.current;
      const endingParticipant = otherParticipantRef.current;

      setStatus('ended');
      setCallId(null);

      // Save call history locally before deleting from Realtime DB
      if (endingCallId && user && endingStartedAt && chatId) {
        const endedAt = Date.now();
        // Duration counts only connected time, not ring time. If the other
        // participant never joined (missed/no-answer), connectedAt is null → duration 0.
        const duration = endingConnectedAt
          ? Math.floor((endedAt - endingConnectedAt) / 1000)
          : 0;

        // Last-resort: resolve from thread if ref was somehow never set
        let participant = endingParticipant;
        if (!participant) {
          const thread = threads.find((t) => t.chatId === chatId);
          const threadOther = thread?.participants.find((p) => p.userId !== user.userId);
          if (threadOther) {
            participant = { userId: threadOther.userId, displayName: resolveDisplayName(threadOther, 'Unknown'), photoURL: threadOther.photoURL };
          }
        }

        const historyEntry: CallHistoryEntry = {
          callId: endingCallId,
          chatId,
          groupId,
          type: callType,
          direction: isInitiatorRef.current ? 'outgoing' : 'incoming',
          otherParticipant: {
            userId: participant?.userId || 'unknown',
            // Guard again even though every upstream writer of `participant`
            // is now guarded — this is the sink that actually persists to
            // AsyncStorage, so it must never let an empty name through.
            displayName: resolveDisplayName(participant, 'Unknown'),
            photoURL: participant?.photoURL,
          },
          startedAt: endingStartedAt,
          endedAt,
          duration,
          status: duration > 0 ? 'completed' : 'missed',
        };

        await saveCallToHistory(historyEntry);

        // Drop a system entry into the chat so the call appears in the
        // conversation timeline like WhatsApp / iMessage. Only for direct
        // (1:1) chats — group chats don't typically inline call summaries.
        // Gated on isInitiator so we don't double-write: both sides run endCall
        // when the call finishes, but only the caller persists the entry.
        try {
          const thread = threads.find((t) => t.chatId === chatId);
          if (thread?.type === 'direct' && isInitiatorRef.current) {
            const mins = Math.floor(duration / 60);
            const secs = duration % 60;
            const durationLabel = duration > 0
              ? `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
              : '';
            const callIcon = callType === 'video' ? '📹' : '📞';
            // duration === 0 means the other side never connected (missed/no answer)
            const directionLabel = duration === 0 ? 'No answer' : 'Outgoing call';
            const summary = duration > 0
              ? `${callIcon} ${directionLabel} · ${durationLabel}`
              : `${callIcon} ${directionLabel}`;
            await sendMessage({
              chatId,
              content: summary,
              type: 'system',
              groupId,
            });
          }
        } catch (msgError) {
          console.warn('Failed to drop call summary into chat', msgError);
        }
      }

      // Remove this participant from signaling.
      if (endingCallId && user) {
        await leaveCall(endingCallId, user.userId);
      }

      // Kill the pending audio timers FIRST so a late watchdog/video-reapply
      // fire can't re-activate the session we're tearing down (which would also
      // flip the ownership flags after we snapshot them just below).
      if (audioWatchdogRef.current) {
        clearTimeout(audioWatchdogRef.current);
        audioWatchdogRef.current = null;
      }
      if (videoModeReapplyRef.current) {
        clearInterval(videoModeReapplyRef.current);
        videoModeReapplyRef.current = null;
      }

      // With CallKit, deactivation is CallKit's job (didDeactivateAudioSession
      // → audioSessionDidDeactivate); a JS setActive(false) here races it.
      // Exception: when JS owns activation (Android, a never-activated session,
      // or the watchdog fallback that activated from JS) CallKit won't
      // deactivate — so JS must, or the mic indicator stays on AND the next
      // call inherits a live session and is silent. Snapshot ownership BEFORE
      // nativeCallService.endCall(), which now clears the activation flags as
      // part of teardown (so an abnormal end that never triggers CallKit's
      // didDeactivate can't leave a stale `true` that silences the next call).
      const jsOwnsActivation = nativeCallService.jsOwnsAudioSession();
      if (jsOwnsActivation) {
        try {
          // Deactivate the OS session BEFORE endCall notifies WebRTC
          // (audioSessionDidDeactivate) so the teardown order stays canonical:
          // session inactive first, then the WebRTC handoff.
          await AudioSession.stopAudioSession();
        } catch (audioErr) {
          console.warn('useCallManager: AudioSession.stopAudioSession failed', audioErr);
        }
      }

      if (endingCallId) {
        await nativeCallService.endCall(endingCallId);
        nativeCallService.clearCall(endingCallId);
      }

      callIdRef.current = null;
      callStartedAtRef.current = null;
      connectedAtRef.current = null;
      otherParticipantRef.current = null;
      hasSessionToCleanupRef.current = false;
      hasReportedConnectedNativeRef.current = false;

      // Defensive belt-and-suspenders: endCall already reset the activation
      // flags (and, for a JS-owned session, notified WebRTC). This idempotent
      // clear also covers the endingCallId===null path where endCall never ran.
      nativeCallService.resetAudioSession();
      debugLog('useCallManager call ended');

    } catch (err) {
      console.error('Error ending call', err);
    } finally {
      // Keep `true` while idle; reset when starting/joining a new call.
    }
  }, [user, chatId, groupId, threads, callType, cleanupSubscriptions, sendMessage]);

  useEffect(() => {
    endCallRef.current = endCall;
  }, [endCall]);

  // Outgoing ring timeout — if an initiated call is never answered, tear down
  // the LiveKit/CallKit call but surface a "No answer" state (WhatsApp-style)
  // with Call again / Message options instead of just closing, and notify the
  // callee with a missed-call push. Only the initiator arms this; the callee's
  // ring is bounded by CallKit/ConnectionService natively.
  useEffect(() => {
    if (status !== 'ringing' || !isInitiatorRef.current) return;
    const timer = setTimeout(() => {
      debugLog('useCallManager outgoing ring timed out; no answer');
      const timedOutCallId = callIdRef.current;
      setNoAnswer(true);
      // Notify the callee of the missed call (best-effort; idempotent server-side).
      if (timedOutCallId) {
        try {
          const functions = getFunctions(getApp());
          void httpsCallable(functions, 'reportMissedCall')({ callId: timedOutCallId }).catch((e) =>
            console.warn('reportMissedCall failed', e),
          );
        } catch (e) {
          console.warn('reportMissedCall dispatch failed', e);
        }
      }
      void endCallRef.current('no-answer');
    }, RING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    hasSessionToCleanupRef.current = Boolean(callIdRef.current || callId || token || serverUrl);
  }, [callId, serverUrl, token, status]);

  useEffect(() => {
    const timer = setTimeout(() => {
      // React StrictMode does a mount->cleanup->mount simulation in dev. Avoid treating
      // that first cleanup pass as a real unmount that should terminate the call.
      allowUnmountCleanupRef.current = true;
    }, 0);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const unsubscribeNativeEnd = nativeCallService.subscribe('end', ({ appCallId }) => {
      if (!appCallId || appCallId !== callIdRef.current || isEndingRef.current) {
        return;
      }

      debugLog('useCallManager received native end-call action');
      void endCallRef.current('manual');
    });

    const unsubscribeNativeMute = nativeCallService.subscribe('mute', ({ appCallId, muted }) => {
      if (appCallId && appCallId !== callIdRef.current) {
        return;
      }

      setIsMuted(muted);
    });

    return () => {
      unsubscribeNativeEnd();
      unsubscribeNativeMute();
    };
  }, []);

  // Local state toggles (actual media toggle happens in the UI via LiveKitRoom)
  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev);
  }, []);

  const toggleCamera = useCallback(() => {
    setIsCameraOff((prev) => !prev);
  }, []);

  // Cleanup on unmount:
  // - If there is no active call session yet, only clean listeners.
  // - If call state exists, end the call once.
  useEffect(() => {
    return () => {
      if (!allowUnmountCleanupRef.current) {
        cleanupSubscriptions();
        return;
      }

      if (!hasSessionToCleanupRef.current) {
        cleanupSubscriptions();
        return;
      }

      void endCallRef.current('unmount');
    };
  }, [cleanupSubscriptions]);

  // Watch for incoming calls
  useEffect(() => {
    if (!chatId || !user?.userId || status !== 'idle') {
      return;
    }

    const unsubscribe = subscribeToActiveCall(chatId, user.userId, (session) => {
      if (session && session.initiatorId !== user?.userId && session.status === 'ringing') {
        debugLog('useCallManager incoming call detected');
        // You might want to trigger a ringtone here
      }
    });

    return () => unsubscribe();
  }, [chatId, user?.userId, status]);

  return {
    status,
    callId,
    error,
    isMuted,
    isCameraOff,
    serverUrl,
    token,
    callType,
    remoteRinging,
    noAnswer,
    startCall,
    joinExistingCall,
    endCall,
    toggleMute,
    toggleCamera,
  };
};
