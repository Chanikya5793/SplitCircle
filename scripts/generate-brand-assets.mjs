import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import pngjs from 'pngjs';

const { PNG } = pngjs;

const projectRoot = resolve(import.meta.dirname, '..');
const generatedRoot = join(projectRoot, 'assets/brand/generated');

const colors = {
  ink: '#3B1259',
  plum: '#2A0B40',
  deep: '#1B0730',
  gold: '#E8A13D',
  cream: '#FBF7F0',
  reversedGold: '#F5C15C',
  reversedInk: '#E9D5FF',
};

const petalPath = 'M60 60 C 32 46, 36 22, 60 12 C 84 22, 88 46, 60 60 Z';
const dots = [
  [88.99, 31.01],
  [88.99, 88.99],
  [31.01, 88.99],
  [31.01, 31.01],
];

const palettes = {
  primary: {
    petals: [colors.gold, colors.ink, colors.ink, colors.ink],
    center: colors.ink,
    dots: colors.gold,
  },
  reversed: {
    petals: [colors.reversedGold, colors.reversedInk, colors.reversedInk, colors.reversedInk],
    center: colors.reversedInk,
    dots: colors.reversedGold,
  },
  appIcon: {
    petals: [colors.reversedInk, colors.reversedInk, colors.reversedInk, colors.reversedInk],
    center: colors.reversedGold,
    dots: colors.reversedGold,
  },
  tinted: {
    petals: ['#111111', '#111111', '#111111', '#111111'],
    center: '#6A6A6A',
    dots: '#6A6A6A',
  },
  monochromeWhite: {
    petals: ['#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFF'],
    center: '#FFFFFF',
    dots: '#FFFFFF',
  },
  monoInk: {
    petals: [colors.ink, colors.ink, colors.ink, colors.ink],
    center: colors.ink,
    dots: colors.ink,
  },
};

const renderMark = ({
  palette,
  background,
  viewBox = '0 0 120 120',
  simplified = false,
}) => {
  const [x, y, width, height] = viewBox.split(' ').map(Number);
  const strokeWidth = simplified ? 9 : 7.2;
  const dashArray = simplified ? '14.27 25.46 130.76' : '15.78 22.43 130.76';
  const backgroundNode = background
    ? `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${background}"/>`
    : '';
  const petals = palette.petals
    .map(
      (color, index) =>
        `<path d="${petalPath}" transform="rotate(${index * 90} 60 60)" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${dashArray}"/>`,
    )
    .join('');
  const dotNodes = simplified
    ? ''
    : dots
        .map(
          ([cx, cy]) =>
            `<circle cx="${cx}" cy="${cy}" r="4.2" fill="${palette.dots}"/>`,
        )
        .join('');

  return [
    '<svg xmlns="http://www.w3.org/2000/svg"',
    ` viewBox="${viewBox}" fill="none">`,
    backgroundNode,
    petals,
    `<circle cx="60" cy="60" r="${simplified ? 7 : 8.5}" fill="${palette.center}"/>`,
    dotNodes,
    '</svg>',
  ].join('');
};

const svgDefinitions = {
  'primary.svg': renderMark({ palette: palettes.primary }),
  'reversed.svg': renderMark({ palette: palettes.reversed }),
  'app-icon.svg': renderMark({
    palette: palettes.appIcon,
    background: colors.plum,
    viewBox: '-22 -22 164 164',
  }),
  'app-icon-dark.svg': renderMark({
    palette: palettes.appIcon,
    background: colors.deep,
    viewBox: '-22 -22 164 164',
  }),
  'app-icon-tinted.svg': renderMark({
    palette: palettes.tinted,
    background: '#FFFFFF',
    viewBox: '-22 -22 164 164',
  }),
  'adaptive-foreground.svg': renderMark({
    palette: palettes.appIcon,
    viewBox: '-28 -28 176 176',
  }),
  'adaptive-monochrome.svg': renderMark({
    palette: palettes.monochromeWhite,
    viewBox: '-28 -28 176 176',
  }),
  'notification-icon.svg': renderMark({
    palette: palettes.monochromeWhite,
    viewBox: '-28 -28 176 176',
    simplified: true,
  }),
  'favicon.svg': renderMark({
    palette: palettes.monoInk,
    viewBox: '-8 -8 136 136',
    simplified: true,
  }),
};

const rasterize = (svgName, outputPath, size) => {
  const svgPath = join(generatedRoot, svgName);
  mkdirSync(dirname(outputPath), { recursive: true });
  const result = spawnSync(
    'sips',
    ['-z', String(size), String(size), '-s', 'format', 'png', svgPath, '--out', outputPath],
    { encoding: 'utf8' },
  );

  if (result.status !== 0) {
    throw new Error(`sips failed for ${svgName}: ${result.stderr || result.stdout}`);
  }
};

const stripAlphaChannel = (path) => {
  const png = PNG.sync.read(readFileSync(path));
  writeFileSync(path, PNG.sync.write(png, { colorType: 2 }));
};

mkdirSync(generatedRoot, { recursive: true });
for (const [filename, source] of Object.entries(svgDefinitions)) {
  writeFileSync(join(generatedRoot, filename), source);
}

const outputs = [
  ['app-icon.svg', 'assets/icon.png', 1024],
  ['app-icon-dark.svg', 'assets/icon-dark.png', 1024],
  ['app-icon-tinted.svg', 'assets/icon-tinted.png', 1024],
  ['adaptive-foreground.svg', 'assets/adaptive-icon.png', 1024],
  ['adaptive-monochrome.svg', 'assets/adaptive-icon-monochrome.png', 1024],
  ['primary.svg', 'assets/splash-icon.png', 1024],
  ['reversed.svg', 'assets/splash-icon-dark.png', 1024],
  ['favicon.svg', 'assets/favicon.png', 64],
  ['notification-icon.svg', 'assets/notification-icon.png', 96],
  ['app-icon.svg', 'assets/brand/generated/app-icon.png', 1024],
  ['app-icon-dark.svg', 'assets/brand/generated/app-icon-dark.png', 1024],
  ['app-icon-tinted.svg', 'assets/brand/generated/app-icon-tinted.png', 1024],
  ['primary.svg', 'assets/brand/generated/splash-light.png', 1024],
  ['reversed.svg', 'assets/brand/generated/splash-dark.png', 1024],
];

const iosAppIconRoot = 'ios/SplitCircle/Images.xcassets/AppIcon.appiconset';
outputs.push(
  ['app-icon.svg', `${iosAppIconRoot}/App-Icon-1024x1024@1x.png`, 1024],
  ['app-icon-dark.svg', `${iosAppIconRoot}/App-Icon-dark-1024x1024@1x.png`, 1024],
  ['app-icon-tinted.svg', `${iosAppIconRoot}/App-Icon-tinted-1024x1024@1x.png`, 1024],
);

const iosSplashRoot = 'ios/SplitCircle/Images.xcassets/SplashScreenLogo.imageset';
for (const [scale, size, suffix] of [
  [1, 112, ''],
  [2, 224, '@2x'],
  [3, 336, '@3x'],
]) {
  outputs.push(
    ['primary.svg', `${iosSplashRoot}/image${suffix}.png`, size],
    ['reversed.svg', `${iosSplashRoot}/image-dark${suffix}.png`, size],
  );
}

const androidDensities = [
  { name: 'mdpi', legacy: 48, foreground: 108, splash: 288, notification: 24 },
  { name: 'hdpi', legacy: 72, foreground: 162, splash: 432, notification: 36 },
  { name: 'xhdpi', legacy: 96, foreground: 216, splash: 576, notification: 48 },
  { name: 'xxhdpi', legacy: 144, foreground: 324, splash: 864, notification: 72 },
  { name: 'xxxhdpi', legacy: 192, foreground: 432, splash: 1152, notification: 96 },
];

for (const density of androidDensities) {
  const mipmap = `android/app/src/main/res/mipmap-${density.name}`;
  const drawable = `android/app/src/main/res/drawable-${density.name}`;
  const drawableNight = `android/app/src/main/res/drawable-night-${density.name}`;
  outputs.push(
    ['app-icon.svg', `${mipmap}/ic_launcher.png`, density.legacy],
    ['app-icon.svg', `${mipmap}/ic_launcher_round.png`, density.legacy],
    ['adaptive-foreground.svg', `${mipmap}/ic_launcher_foreground.png`, density.foreground],
    ['adaptive-monochrome.svg', `${mipmap}/ic_launcher_monochrome.png`, density.foreground],
    ['primary.svg', `${drawable}/splashscreen_logo.png`, density.splash],
    ['reversed.svg', `${drawableNight}/splashscreen_logo.png`, density.splash],
    ['notification-icon.svg', `${drawable}/notification_icon.png`, density.notification],
  );
}

for (const [svgName, relativeOutput, size] of outputs) {
  rasterize(svgName, join(projectRoot, relativeOutput), size);
}

for (const relativePath of [
  'assets/icon.png',
  'assets/icon-dark.png',
  'assets/icon-tinted.png',
  'assets/brand/generated/app-icon.png',
  'assets/brand/generated/app-icon-dark.png',
  'assets/brand/generated/app-icon-tinted.png',
  `${iosAppIconRoot}/App-Icon-1024x1024@1x.png`,
  `${iosAppIconRoot}/App-Icon-dark-1024x1024@1x.png`,
  `${iosAppIconRoot}/App-Icon-tinted-1024x1024@1x.png`,
]) {
  stripAlphaChannel(join(projectRoot, relativePath));
}

console.log(`Generated ${outputs.length} ManaSplit raster assets.`);
