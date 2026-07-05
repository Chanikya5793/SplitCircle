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
    void mod.setAudioModeAsync?.({ playsInSilentMode: true }).catch(() => {});
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const created = mod.createAudioPlayer(require('../../assets/sounds/ringback.wav'));
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
  try {
    player?.pause();
    player?.remove();
  } catch {
    // best-effort teardown
  }
  player = null;
};
