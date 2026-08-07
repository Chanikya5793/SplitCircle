// Built-in wallpaper catalog. Two kinds:
//   • 'blob'  — the app's signature ANIMATED liquid background (moving circles)
//               in a chosen colour palette. Selecting one renders live blobs
//               (LiquidBackground), not a static image; the bundled JPEG is only
//               the picker thumbnail.
//   • 'photo' — a bundled still image copied into the wallpapers dir (1400px
//               JPEGs, ~150-250KB) so users can pick a backdrop without photo
//               access.

import { SOLID_BACKGROUNDS, type SolidBackground } from './solidBackgrounds';

export { SOLID_BACKGROUNDS };
export type { SolidBackground };

export type BlobTrio = [string, string, string];

export type CatalogWallpaper =
  | {
      id: string;
      label: string;
      kind: 'blob';
      /** Per-scheme blob colours; LiquidBackground crossfades light↔dark. */
      light: BlobTrio;
      dark: BlobTrio;
      /** When true, ignore light/dark and follow the app's current accent theme. */
      adaptive?: boolean;
      /** Still preview for the picker rail (require() module id). */
      thumb: number;
    }
  | {
      id: string;
      label: string;
      kind: 'photo';
      source: number; // require() module id
    }
  | SolidBackground;

const mono = (light: string, dark: string): { light: BlobTrio; dark: BlobTrio } => ({
  light: [light, light, light],
  dark: [dark, dark, dark],
});

export const WALLPAPER_CATALOG: CatalogWallpaper[] = [
  ...SOLID_BACKGROUNDS,
  // Adaptive — animated blobs that follow the app's current accent theme (recolour
  // live when you change the accent). light/dark are placeholders; adaptive wins.
  { id: 'blob-adaptive', label: 'Adaptive', kind: 'blob', adaptive: true, light: ['#a5c8ff', '#d0b3ff', '#9df0cf'], dark: ['#173B66', '#432C7A', '#0B4A37'], thumb: require('../../assets/wallpapers/blob-adaptive.jpg') },
  // Prism — a mix of all the colours at once.
  { id: 'blob-prism', label: 'Prism', kind: 'blob', light: ['#f79ab3', '#8fbaff', '#7fe6c4'], dark: ['#7F1D3A', '#0F4C75', '#0B4A37'], thumb: require('../../assets/wallpapers/blob-prism.jpg') },
  // Signature ANIMATED liquid-blob backdrops — moving circles in accent colours.
  { id: 'blob-blue', label: 'Blue', kind: 'blob', light: ['#a5c8ff', '#c4e0f9', '#9bb8f0'], dark: ['#173B66', '#1C2E58', '#0F4C75'], thumb: require('../../assets/wallpapers/blob-blue.jpg') },
  { id: 'blob-purple', label: 'Purple', kind: 'blob', light: ['#d0b3ff', '#e3d1fc', '#b79aef'], dark: ['#432C7A', '#33245E', '#4527A0'], thumb: require('../../assets/wallpapers/blob-purple.jpg') },
  { id: 'blob-teal', label: 'Teal', kind: 'blob', light: ['#9df0cf', '#c8f2e4', '#7fe0c0'], dark: ['#0B4A37', '#0A3A3A', '#14532D'], thumb: require('../../assets/wallpapers/blob-teal.jpg') },
  { id: 'blob-orange', label: 'Orange', kind: 'blob', light: ['#ffc9a3', '#ffe1c9', '#f5b083'], dark: ['#6E3410', '#5C2E0E', '#7C2D12'], thumb: require('../../assets/wallpapers/blob-orange.jpg') },
  { id: 'blob-pink', label: 'Pink', kind: 'blob', light: ['#ffb3c4', '#ffd6df', '#f79ab3'], dark: ['#6B1130', '#581C3C', '#7F1D3A'], thumb: require('../../assets/wallpapers/blob-pink.jpg') },
  { id: 'blob-slate', label: 'Slate', kind: 'blob', light: ['#cbd5e1', '#e2e8f0', '#b6c2d2'], dark: ['#374151', '#2B3444', '#1F2937'], thumb: require('../../assets/wallpapers/blob-slate.jpg') },
  // Single-colour washes (one hue, still animated).
  { id: 'blob-mono-blue', label: 'Blue Wash', kind: 'blob', ...mono('#a5c8ff', '#173B66'), thumb: require('../../assets/wallpapers/blob-mono-blue.jpg') },
  { id: 'blob-mono-purple', label: 'Purple Wash', kind: 'blob', ...mono('#d0b3ff', '#432C7A'), thumb: require('../../assets/wallpapers/blob-mono-purple.jpg') },
  { id: 'blob-mono-teal', label: 'Teal Wash', kind: 'blob', ...mono('#9df0cf', '#0B4A37'), thumb: require('../../assets/wallpapers/blob-mono-teal.jpg') },
  { id: 'blob-mono-orange', label: 'Orange Wash', kind: 'blob', ...mono('#ffc9a3', '#6E3410'), thumb: require('../../assets/wallpapers/blob-mono-orange.jpg') },
  { id: 'blob-mono-pink', label: 'Pink Wash', kind: 'blob', ...mono('#ffb3c4', '#6B1130'), thumb: require('../../assets/wallpapers/blob-mono-pink.jpg') },
  { id: 'blob-mono-slate', label: 'Slate Wash', kind: 'blob', ...mono('#cbd5e1', '#374151'), thumb: require('../../assets/wallpapers/blob-mono-slate.jpg') },
  // Still photo backdrops.
  { id: 'bloom-pink', label: 'Pink Bloom', kind: 'photo', source: require('../../assets/wallpapers/bloom-pink.jpg') },
  { id: 'bloom-blue', label: 'Blue Bloom', kind: 'photo', source: require('../../assets/wallpapers/bloom-blue.jpg') },
  { id: 'bloom-purple', label: 'Purple Bloom', kind: 'photo', source: require('../../assets/wallpapers/bloom-purple.jpg') },
  { id: 'bloom-yellow', label: 'Golden Bloom', kind: 'photo', source: require('../../assets/wallpapers/bloom-yellow.jpg') },
  { id: 'pop-green', label: 'Green Pop', kind: 'photo', source: require('../../assets/wallpapers/pop-green.jpg') },
  { id: 'pop-orange', label: 'Orange Pop', kind: 'photo', source: require('../../assets/wallpapers/pop-orange.jpg') },
  { id: 'sky-radial', label: 'Radial Sky', kind: 'photo', source: require('../../assets/wallpapers/sky-radial.jpg') },
  { id: 'sonoma-hills', label: 'Golden Hills', kind: 'photo', source: require('../../assets/wallpapers/sonoma-hills.jpg') },
];
