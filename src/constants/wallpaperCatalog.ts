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
  { id: 'bloom-pink', label: 'Pink Bloom', source: require('../../assets/wallpapers/bloom-pink.jpg') },
  { id: 'bloom-blue', label: 'Blue Bloom', source: require('../../assets/wallpapers/bloom-blue.jpg') },
  { id: 'bloom-purple', label: 'Purple Bloom', source: require('../../assets/wallpapers/bloom-purple.jpg') },
  { id: 'bloom-yellow', label: 'Golden Bloom', source: require('../../assets/wallpapers/bloom-yellow.jpg') },
  { id: 'pop-green', label: 'Green Pop', source: require('../../assets/wallpapers/pop-green.jpg') },
  { id: 'pop-orange', label: 'Orange Pop', source: require('../../assets/wallpapers/pop-orange.jpg') },
  { id: 'sky-radial', label: 'Radial Sky', source: require('../../assets/wallpapers/sky-radial.jpg') },
  { id: 'sonoma-hills', label: 'Golden Hills', source: require('../../assets/wallpapers/sonoma-hills.jpg') },
];
