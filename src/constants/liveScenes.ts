// Live wallpapers: animated scenes drawn by a GPU shader (Skia RuntimeEffect),
// rendered by components/LiveWallpaper.tsx.
//
// Deliberately free of imports (like solidBackgrounds.ts) so tests can load
// the real palettes and shader sources in node.
//
// Every scene follows the same rules, because it sits behind real content:
//  - SLOW. Motion you notice out of the corner of your eye, never something
//    that competes with text. Periods are tens of seconds.
//  - SOFT. Low contrast within the scene; in dark mode the luminance stays
//    low so white text keeps its contrast, in light mode it stays high.
//  - ONE SHADER, cheap. A full-screen shader runs per pixel; each scene is a
//    handful of trig calls and at most a few short loops, and the renderer
//    caps it at ~30fps and stops it entirely off-screen or with Reduce Motion.
//
// Shared uniforms: u_res (px), u_time (s), u_mode (0 light → 1 dark, driven by
// the theme crossfade so a scheme switch blends instead of popping), and five
// palette colours per scheme (l0..l4 / d0..d4). c0/c1 are the base gradient
// (top → bottom); c2..c4 are the scene's accents.

export type LiveSceneId = 'aurora' | 'mesh' | 'night' | 'tides' | 'fireflies' | 'lagoon';

export type Rgb5 = [string, string, string, string, string];

export interface LiveScene {
  id: LiveSceneId;
  label: string;
  /** One line for the picker / accessibility. */
  description: string;
  light: Rgb5;
  dark: Rgb5;
  /** SkSL body. Receives `c0..c4` (already mixed for the scheme), `uv`, `p`, `t`. */
  body: string;
}

/** Shared prelude: uniforms, scheme mixing and a cheap hash. */
export const LIVE_SHADER_PRELUDE = `
uniform float2 u_res;
uniform float u_time;
uniform float u_mode;
uniform float3 l0; uniform float3 l1; uniform float3 l2; uniform float3 l3; uniform float3 l4;
uniform float3 d0; uniform float3 d1; uniform float3 d2; uniform float3 d3; uniform float3 d4;

float hash(float2 q) { return fract(sin(dot(q, float2(127.1, 311.7))) * 43758.5453); }
`;

export const liveShaderSource = (scene: LiveScene): string => `${LIVE_SHADER_PRELUDE}
half4 main(float2 p) {
  float2 uv = p / u_res;
  float t = u_time;
  float3 c0 = mix(l0, d0, u_mode);
  float3 c1 = mix(l1, d1, u_mode);
  float3 c2 = mix(l2, d2, u_mode);
  float3 c3 = mix(l3, d3, u_mode);
  float3 c4 = mix(l4, d4, u_mode);
  float3 col = mix(c0, c1, uv.y);
${scene.body}
  // A whisper of grain: breaks up 8-bit banding in the long soft gradients.
  col += (hash(p + fract(t)) - 0.5) / 255.0;
  return half4(half3(clamp(col, 0.0, 1.0)), 1.0);
}
`;

export const LIVE_SCENES: LiveScene[] = [
  {
    id: 'aurora',
    label: 'Aurora',
    description: 'Ribbons of northern light drifting across the sky',
    light: ['#EAF4FF', '#F7F2FF', '#7FE3C4', '#9FB8FF', '#E7A9FF'],
    dark: ['#06121F', '#0E0A1F', '#1FA58A', '#3657C9', '#8A3FB8'],
    body: `
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float y = 0.16 + 0.14 * fi
      + 0.07 * sin(uv.x * 2.6 + t * (0.11 + 0.03 * fi) + fi * 1.9)
      + 0.03 * sin(uv.x * 6.3 - t * 0.17 + fi * 4.1);
    float d = uv.y - y;
    // Curtains hang DOWN from the ribbon, so the falloff is lopsided.
    float band = exp(-d * d * (d > 0.0 ? 60.0 : 260.0));
    // Curtain folds: two incommensurate frequencies so they never line up
    // into a regular comb, kept shallow so the ribbon reads as light.
    float streak = 0.84
      + 0.10 * sin(uv.x * 23.0 + t * 0.31 + fi * 3.0 + 1.7 * sin(uv.x * 5.0 + t * 0.13))
      + 0.06 * sin(uv.x * 51.0 - t * 0.22 + fi);
    float3 bc = i == 0 ? c2 : (i == 1 ? c3 : c4);
    col = mix(col, bc, clamp(band * streak * 0.55, 0.0, 1.0));
  }`,
  },
  {
    id: 'mesh',
    label: 'Silk',
    description: 'A soft colour mesh that slowly folds into itself',
    light: ['#F6F3FF', '#FFF4EE', '#B7C9FF', '#FFC6D9', '#B9F0DD'],
    dark: ['#0D0F1C', '#140D18', '#27306E', '#5C1E4A', '#114B47'],
    body: `
  float2 a = float2(0.20 + 0.18 * sin(t * 0.07), 0.18 + 0.14 * cos(t * 0.09));
  float2 b = float2(0.82 + 0.14 * cos(t * 0.06 + 1.0), 0.30 + 0.20 * sin(t * 0.08 + 2.0));
  float2 c = float2(0.30 + 0.20 * cos(t * 0.05 + 3.0), 0.82 + 0.12 * sin(t * 0.07 + 1.5));
  float2 e = float2(0.78 + 0.16 * sin(t * 0.06 + 4.0), 0.78 + 0.14 * cos(t * 0.05 + 2.5));
  float2 q = float2(uv.x, uv.y * (u_res.y / u_res.x) * 0.55);
  float2 sa = float2(a.x, a.y * (u_res.y / u_res.x) * 0.55);
  float2 sb = float2(b.x, b.y * (u_res.y / u_res.x) * 0.55);
  float2 sc = float2(c.x, c.y * (u_res.y / u_res.x) * 0.55);
  float2 se = float2(e.x, e.y * (u_res.y / u_res.x) * 0.55);
  float wa = 1.0 / (dot(q - sa, q - sa) + 0.03);
  float wb = 1.0 / (dot(q - sb, q - sb) + 0.03);
  float wc = 1.0 / (dot(q - sc, q - sc) + 0.03);
  float we = 1.0 / (dot(q - se, q - se) + 0.03);
  float3 m = (c2 * wa + c3 * wb + c4 * wc + mix(c0, c1, 0.5) * we) / (wa + wb + wc + we);
  col = mix(col, m, 0.85);`,
  },
  {
    id: 'night',
    label: 'Night Sky',
    description: 'Twinkling stars over a deep, slow-turning sky',
    light: ['#C9D8FF', '#FFE2CF', '#FFFFFF', '#A8B8F5', '#FFC2A6'],
    dark: ['#050816', '#141033', '#FFFFFF', '#3A3A8C', '#1F4A7A'],
    body: `
  // Milky-way haze along a diagonal.
  float diag = uv.x * 0.8 + uv.y * 0.6;
  float haze = exp(-pow(diag - 0.75 - 0.05 * sin(t * 0.03), 2.0) * 18.0);
  col = mix(col, c3, haze * mix(0.55, 0.35, u_mode));
  col = mix(col, c4, exp(-pow(uv.y - 1.05, 2.0) * 6.0) * mix(0.6, 0.35, u_mode));
  // Two star layers drifting at different speeds for depth.
  float starAmount = mix(0.35, 1.0, u_mode);
  for (int layer = 0; layer < 2; layer++) {
    float fl = float(layer);
    float cell = min(u_res.x, u_res.y) * (0.045 + 0.03 * fl);
    float2 g = (p + float2(t * (2.0 + 3.0 * fl), 0.0)) / cell;
    float2 id = floor(g);
    float2 f = fract(g) - 0.5;
    float h = hash(id + fl * 17.0);
    if (h > 0.86) {
      float2 off = float2(hash(id + 3.1), hash(id + 7.7)) - 0.5;
      float dist = length(f - off * 0.6);
      float tw = 0.55 + 0.45 * sin(t * (0.6 + h * 1.4) + h * 40.0);
      float star = smoothstep(0.09 - 0.03 * fl, 0.0, dist) * tw;
      col += c2 * star * starAmount * (0.9 - 0.3 * fl);
    }
  }`,
  },
  {
    id: 'tides',
    label: 'Tides',
    description: 'Gentle layered waves rolling under a calm sky',
    light: ['#EEF7FF', '#E6F3F7', '#B4DDF0', '#8EC6E6', '#6FAFD9'],
    dark: ['#06111C', '#071A26', '#0E3A52', '#0F4C6B', '#136386'],
    body: `
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float y = 0.58 + 0.095 * fi
      + 0.022 * sin(uv.x * (3.0 + fi) * 3.14159 + t * (0.22 + 0.06 * fi) + fi * 2.0)
      + 0.010 * sin(uv.x * 17.0 - t * 0.4 + fi);
    float3 wc = i == 0 ? c2 : (i == 1 ? c3 : c4);
    float edge = smoothstep(y - 0.004, y + 0.012, uv.y);
    col = mix(col, mix(wc, c4, fi / 3.0), edge * 0.55);
    // A thin highlight riding each crest.
    col += c2 * exp(-pow((uv.y - y) * 160.0, 2.0)) * 0.10;
  }`,
  },
  {
    id: 'fireflies',
    label: 'Fireflies',
    description: 'Warm lights drifting slowly upward',
    light: ['#FFF8EE', '#F3F0FF', '#FFC97A', '#FF9FB0', '#9FD8FF'],
    dark: ['#0B0A10', '#0F1416', '#FFB547', '#FF6F91', '#58C4FF'],
    body: `
  float minRes = min(u_res.x, u_res.y);
  // Light mode needs MORE glow, not less: pale lights on a pale sky vanish.
  float glowAmount = mix(0.70, 0.60, u_mode);
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    float h1 = hash(float2(fi, 1.3));
    float h2 = hash(float2(fi, 7.9));
    float h3 = hash(float2(fi, 4.2));
    float2 pos = float2(
      fract(h1 + 0.035 * sin(t * (0.08 + 0.05 * h2) + fi)),
      1.0 - fract(h2 + t * (0.006 + 0.010 * h3))
    ) * u_res;
    float r = minRes * (0.06 + 0.10 * h3);
    float d = length(p - pos);
    float glow = smoothstep(r, 0.0, d);
    float pulse = 0.65 + 0.35 * sin(t * (0.5 + h1) + fi * 2.3);
    float3 fc = h3 < 0.34 ? c2 : (h3 < 0.67 ? c3 : c4);
    col = mix(col, fc, clamp(glow * glowAmount * pulse, 0.0, 1.0));
  }`,
  },
  {
    id: 'lagoon',
    label: 'Lagoon',
    description: 'Sunlight dancing on shallow water',
    light: ['#E8FBF8', '#E6F4FF', '#FFFFFF', '#9FE3DA', '#7CC7E8'],
    dark: ['#03181A', '#041420', '#7FE7DC', '#0C5257', '#0B3D5C'],
    body: `
  col = mix(col, mix(c3, c4, uv.x), 0.45);
  float2 q = float2(uv.x * (u_res.x / u_res.y), uv.y) * 6.28318 * 0.9;
  float2 w = mod(q, 6.28318) - 250.0;
  float2 i2 = w;
  float cc = 1.0;
  float tt0 = t * 0.18 + 23.0;
  for (int n = 0; n < 4; n++) {
    float tt = tt0 * (1.0 - (3.5 / float(n + 1)));
    i2 = w + float2(cos(tt - i2.x) + sin(tt + i2.y), sin(tt - i2.y) + cos(tt + i2.x));
    cc += 1.0 / length(float2(w.x / (sin(i2.x + tt) / 0.005), w.y / (cos(i2.y + tt) / 0.005)));
  }
  cc /= 4.0;
  cc = 1.17 - pow(cc, 1.4);
  float caustic = clamp(pow(abs(cc), 8.0), 0.0, 1.0);
  col = mix(col, c2, caustic * mix(0.45, 0.30, u_mode));`,
  },
];

export const LIVE_SCENE_BY_ID: Record<LiveSceneId, LiveScene> = Object.fromEntries(
  LIVE_SCENES.map((scene) => [scene.id, scene]),
) as Record<LiveSceneId, LiveScene>;

export const isLiveSceneId = (value: unknown): value is LiveSceneId =>
  typeof value === 'string' && value in LIVE_SCENE_BY_ID;
