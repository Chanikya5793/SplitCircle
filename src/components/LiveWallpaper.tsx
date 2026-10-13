// Renders a live wallpaper scene (constants/liveScenes.ts) with a Skia shader.
//
// Cost control, because this sits behind every screen:
//  - Time advances from a Reanimated frame callback capped at ~30fps; nothing
//    else in the tree re-renders (uniforms are a derived shared value).
//  - `animate` false freezes the clock (screen unfocused, app inactive, Reduce
//    Motion — the same useAmbientMotion rule the blob backdrop follows), so a
//    paused scene is a still frame that costs nothing per frame.
//  - Shaders are compiled once per scene and cached. A scene that fails to
//    compile renders nothing, and the caller falls back to the blobs.

import { LIVE_SCENE_BY_ID, liveShaderSource, type LiveSceneId } from '@/constants/liveScenes';
import { Canvas, Fill, Shader, Skia, type SkRuntimeEffect } from '@shopify/react-native-skia';
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useDerivedValue, useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';

const compiled = new Map<LiveSceneId, SkRuntimeEffect | null>();

/** The compiled shader for a scene, or null if it can't be built here. */
export const getLiveEffect = (scene: LiveSceneId): SkRuntimeEffect | null => {
  if (!compiled.has(scene)) {
    let effect: SkRuntimeEffect | null = null;
    try {
      effect = Skia.RuntimeEffect.Make(liveShaderSource(LIVE_SCENE_BY_ID[scene]));
    } catch {
      effect = null;
    }
    if (!effect) console.error(`[LiveWallpaper] Scene "${scene}" failed to compile`);
    compiled.set(scene, effect);
  }
  return compiled.get(scene) ?? null;
};

const rgb = (hex: string): [number, number, number] => {
  const value = hex.replace('#', '');
  const n = parseInt(value.length === 3 ? value.replace(/(.)/g, '$1$1') : value, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

const FRAME_MS = 1000 / 30;

interface LiveWallpaperProps {
  scene: LiveSceneId;
  animate: boolean;
  /** 0 = light, 1 = dark; pass the theme's crossfade progress. */
  mode: SharedValue<number>;
  width: number;
  height: number;
  /** Seconds to start at, so thumbnails of one scene don't move in lockstep. */
  startAt?: number;
  /** Playback speed multiplier (thumbnails run a little faster). */
  speed?: number;
  style?: StyleProp<ViewStyle>;
}

export const LiveWallpaper = ({
  scene,
  animate,
  mode,
  width,
  height,
  startAt = 40,
  speed = 1,
  style,
}: LiveWallpaperProps) => {
  const effect = getLiveEffect(scene);
  const palette = useMemo(() => {
    const def = LIVE_SCENE_BY_ID[scene];
    const uniforms: Record<string, [number, number, number]> = {};
    def.light.forEach((hex, i) => {
      uniforms[`l${i}`] = rgb(hex);
    });
    def.dark.forEach((hex, i) => {
      uniforms[`d${i}`] = rgb(hex);
    });
    return uniforms;
  }, [scene]);

  const time = useSharedValue(startAt);
  const pending = useSharedValue(0);
  const frame = useFrameCallback((info) => {
    'worklet';
    pending.value += info.timeSincePreviousFrame ?? 16;
    if (pending.value < FRAME_MS) return;
    // Wrap well before float precision suffers; every scene is slow enough
    // that the wrap is not visible.
    time.value = (time.value + (pending.value / 1000) * speed) % 3000;
    pending.value = 0;
  }, false);

  useEffect(() => {
    frame.setActive(animate);
    return () => frame.setActive(false);
  }, [animate, frame]);

  const uniforms = useDerivedValue(() => ({
    ...palette,
    u_res: [width, height],
    u_time: time.value,
    u_mode: mode.value,
  }));

  if (!effect || width <= 0 || height <= 0) return null;

  return (
    <Canvas style={[StyleSheet.absoluteFill, style]} pointerEvents="none">
      <Fill>
        <Shader source={effect} uniforms={uniforms} />
      </Fill>
    </Canvas>
  );
};
