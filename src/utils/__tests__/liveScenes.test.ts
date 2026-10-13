import { describe, expect, it } from 'vitest';
import { LIVE_SCENES, isLiveSceneId, liveShaderSource } from '../../constants/liveScenes';

const HEX = /^#[0-9a-f]{6}$/i;

describe('live wallpaper scenes', () => {
  it('each scene has a unique id and five valid colours per scheme', () => {
    expect(new Set(LIVE_SCENES.map((s) => s.id)).size).toBe(LIVE_SCENES.length);
    for (const scene of LIVE_SCENES) {
      expect(scene.light).toHaveLength(5);
      expect(scene.dark).toHaveLength(5);
      for (const hex of [...scene.light, ...scene.dark]) expect(hex).toMatch(HEX);
    }
  });

  it('builds a shader that declares every uniform the renderer sets', () => {
    for (const scene of LIVE_SCENES) {
      const src = liveShaderSource(scene);
      for (const name of ['u_res', 'u_time', 'u_mode', 'l0', 'l4', 'd0', 'd4']) {
        expect(src).toContain(`uniform`);
        expect(src).toMatch(new RegExp(`\\b${name}\\b`));
      }
      expect(src).toContain('half4 main(float2 p)');
    }
  });

  it('dark backdrops stay dark enough for white text', () => {
    const luminance = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    for (const scene of LIVE_SCENES) {
      // The base gradient (c0/c1) is what most of the screen shows.
      for (const hex of scene.dark.slice(0, 2)) expect(luminance(hex)).toBeLessThan(0.05);
      for (const hex of scene.light.slice(0, 2)) expect(luminance(hex)).toBeGreaterThan(0.6);
    }
  });

  it('recognises only known scene ids', () => {
    expect(isLiveSceneId('aurora')).toBe(true);
    expect(isLiveSceneId('volcano')).toBe(false);
    expect(isLiveSceneId(undefined)).toBe(false);
  });
});
