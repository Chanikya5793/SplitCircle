// Built-in wallpaper catalog — bundled with the app so users can pick a
// backdrop without granting photo access. Files live in assets/wallpapers
// (1400px JPEGs, ~150-250KB each). Picking one copies it into the same
// wallpapers directory the gallery flow uses, so the rest of the pipeline
// (slots, hydration, removal) is identical for both sources.

export interface CatalogWallpaper {
  id: string;
  label: string;
  source: number; // require() module id
}

export const WALLPAPER_CATALOG: CatalogWallpaper[] = [
  // Signature liquid-blob backdrops — the app's original look, as static
  // wallpapers. Multi-colour accent trios first, then single-colour washes.
  { id: 'blob-blue', label: 'Blue', source: require('../../assets/wallpapers/blob-blue.jpg') },
  { id: 'blob-purple', label: 'Purple', source: require('../../assets/wallpapers/blob-purple.jpg') },
  { id: 'blob-teal', label: 'Teal', source: require('../../assets/wallpapers/blob-teal.jpg') },
  { id: 'blob-orange', label: 'Orange', source: require('../../assets/wallpapers/blob-orange.jpg') },
  { id: 'blob-pink', label: 'Pink', source: require('../../assets/wallpapers/blob-pink.jpg') },
  { id: 'blob-slate', label: 'Slate', source: require('../../assets/wallpapers/blob-slate.jpg') },
  { id: 'blob-mono-blue', label: 'Blue Wash', source: require('../../assets/wallpapers/blob-mono-blue.jpg') },
  { id: 'blob-mono-purple', label: 'Purple Wash', source: require('../../assets/wallpapers/blob-mono-purple.jpg') },
  { id: 'blob-mono-teal', label: 'Teal Wash', source: require('../../assets/wallpapers/blob-mono-teal.jpg') },
  { id: 'blob-mono-orange', label: 'Orange Wash', source: require('../../assets/wallpapers/blob-mono-orange.jpg') },
  { id: 'blob-mono-pink', label: 'Pink Wash', source: require('../../assets/wallpapers/blob-mono-pink.jpg') },
  { id: 'blob-mono-slate', label: 'Slate Wash', source: require('../../assets/wallpapers/blob-mono-slate.jpg') },
  { id: 'bloom-pink', label: 'Pink Bloom', source: require('../../assets/wallpapers/bloom-pink.jpg') },
  { id: 'bloom-blue', label: 'Blue Bloom', source: require('../../assets/wallpapers/bloom-blue.jpg') },
  { id: 'bloom-purple', label: 'Purple Bloom', source: require('../../assets/wallpapers/bloom-purple.jpg') },
  { id: 'bloom-yellow', label: 'Golden Bloom', source: require('../../assets/wallpapers/bloom-yellow.jpg') },
  { id: 'pop-green', label: 'Green Pop', source: require('../../assets/wallpapers/pop-green.jpg') },
  { id: 'pop-orange', label: 'Orange Pop', source: require('../../assets/wallpapers/pop-orange.jpg') },
  { id: 'sky-radial', label: 'Radial Sky', source: require('../../assets/wallpapers/sky-radial.jpg') },
  { id: 'sonoma-hills', label: 'Golden Hills', source: require('../../assets/wallpapers/sonoma-hills.jpg') },
];
