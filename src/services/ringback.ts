/**
 * ringback.ts — crash-safe caller ringback tone (expo-audio).
 *
 * Plays a looping US-style ringback (440+480 Hz, 2s on / 4s off) to the CALLER
 * while an outgoing call is ringing, so it feels like a real phone call. The
 * native module is probed first (requireOptionalNativeModule) so a binary built
 * before expo-audio existed degrades to silence instead of SIGSEGV'ing release
 * Hermes at module-init (same gotcha as expo-sensors/biometrics). Every failure
 * is swallowed — a missing ringback must never disrupt the actual call.
 */

import { Platform } from 'react-native';

let player: { loop: boolean; volume: number; play: () => void; pause: () => void; remove: () => void } | null = null;

const loadModule = (): typeof import('expo-audio') | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireOptionalNativeModule } = require('expo-modules-core');
    if (!requireOptionalNativeModule('ExpoAudio')) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('expo-audio');
  } catch {
    return null;
  }
};

export const startRingback = (): void => {
  if (player) return;
  const mod = loadModule();
  if (!mod) return;
  try {
    // Let it be audible even with the ringer switch off, like a call ringtone.
    // iOS EXCEPTION: during a CallKit call, CallKit owns the AVAudioSession —
    // setAudioModeAsync would re-set the session category mid-activation and
    // could break the actual call audio, so it's skipped there (the CallKit
    // voiceChat session already plays in silent mode).
    if (Platform.OS !== 'ios') {
      void mod.setAudioModeAsync?.({ playsInSilentMode: true }).catch(() => {});
    }
    // keepAudioSessionActive is CRITICAL: without it, expo-audio's native
    // pause() deactivates the shared AVAudioSession the moment the ringback
    // stops — which is exactly when the call connects. CallKit has already
    // fired didActivateAudioSession and never re-activates, so the live call
    // is left with an INACTIVE session: WebRTC keeps its mic claim (orange
    // indicator) but no audio flows either way. This was the "mic in use but
    // nobody can hear anything" bug.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const created = mod.createAudioPlayer(require('../../assets/sounds/ringback.wav'), {
      keepAudioSessionActive: true,
    });
    created.loop = true;
    created.volume = 0.7;
    created.play();
    player = created as unknown as typeof player;
  } catch (error) {
    console.warn('ringback: start failed', error);
    player = null;
  }
};

export const stopRingback = (): void => {
  // Null the handle FIRST so a re-entrant stop (or a start racing this) can
  // never touch a half-removed player, and so a throw from pause() can't skip
  // remove(). Each teardown step is guarded independently and swallows its
  // error — stopping the ringback must never throw into the call path.
  const current = player;
  player = null;
  if (!current) {
    return;
  }
  try {
    current.pause();
  } catch {
    // best-effort teardown
  }
  try {
    current.remove();
  } catch {
    // best-effort teardown
  }
};
