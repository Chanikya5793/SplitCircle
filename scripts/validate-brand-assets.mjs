import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const projectRoot = resolve(import.meta.dirname, '..');
const failures = [];

const fail = (message) => failures.push(message);
const absolute = (relativePath) => join(projectRoot, relativePath);

const requireFile = (relativePath) => {
  if (!existsSync(absolute(relativePath))) {
    fail(`Missing ${relativePath}`);
    return false;
  }
  return true;
};

const sourceChecksums = {
  'manasplit-muggu-draw-clean.svg':
    '195d7994910e87c0b87588c73868af10706b1b9ac4d1f9e9986dfa13f4cd91d3',
  'manasplit-muggu-draw-reversed.svg':
    'e0c8e565eecf709ce1a1600215d515316ce332bf224fc8915d0866658d14ab80',
  'manasplit-muggu-draw.svg':
    'c5d61d819f19202db357003bed02bc1044c3bb7fd779f60537635e3579941577',
  'manasplit-muggu-final.html':
    'df2be4f82d6bce00408d4306ad5646e42eaf972849e0ab3f15a24d240718c037',
};

for (const [filename, expected] of Object.entries(sourceChecksums)) {
  const relativePath = `assets/brand/source/${filename}`;
  if (!requireFile(relativePath)) continue;
  const actual = createHash('sha256')
    .update(readFileSync(absolute(relativePath)))
    .digest('hex');
  if (actual !== expected) {
    fail(`${relativePath} checksum changed: expected ${expected}, got ${actual}`);
  }
}

const pngDimensions = new Map([
  ['assets/icon.png', 1024],
  ['assets/icon-dark.png', 1024],
  ['assets/icon-tinted.png', 1024],
  ['assets/adaptive-icon.png', 1024],
  ['assets/adaptive-icon-monochrome.png', 1024],
  ['assets/splash-icon.png', 1024],
  ['assets/splash-icon-dark.png', 1024],
  ['assets/favicon.png', 64],
  ['assets/notification-icon.png', 96],
]);

const iosIconRoot = 'ios/SplitCircle/Images.xcassets/AppIcon.appiconset';
for (const filename of [
  'App-Icon-1024x1024@1x.png',
  'App-Icon-dark-1024x1024@1x.png',
  'App-Icon-tinted-1024x1024@1x.png',
]) {
  pngDimensions.set(`${iosIconRoot}/${filename}`, 1024);
}

const iosSplashRoot =
  'ios/SplitCircle/Images.xcassets/SplashScreenLogo.imageset';
for (const [suffix, size] of [
  ['', 112],
  ['@2x', 224],
  ['@3x', 336],
]) {
  pngDimensions.set(`${iosSplashRoot}/image${suffix}.png`, size);
  pngDimensions.set(`${iosSplashRoot}/image-dark${suffix}.png`, size);
}

const densities = [
  { name: 'mdpi', legacy: 48, foreground: 108, splash: 288, notification: 24 },
  { name: 'hdpi', legacy: 72, foreground: 162, splash: 432, notification: 36 },
  { name: 'xhdpi', legacy: 96, foreground: 216, splash: 576, notification: 48 },
  { name: 'xxhdpi', legacy: 144, foreground: 324, splash: 864, notification: 72 },
  {
    name: 'xxxhdpi',
    legacy: 192,
    foreground: 432,
    splash: 1152,
    notification: 96,
  },
];

for (const density of densities) {
  const mipmap = `android/app/src/main/res/mipmap-${density.name}`;
  const drawable = `android/app/src/main/res/drawable-${density.name}`;
  const drawableNight = `android/app/src/main/res/drawable-night-${density.name}`;
  pngDimensions.set(`${mipmap}/ic_launcher.png`, density.legacy);
  pngDimensions.set(`${mipmap}/ic_launcher_round.png`, density.legacy);
  pngDimensions.set(
    `${mipmap}/ic_launcher_foreground.png`,
    density.foreground,
  );
  pngDimensions.set(
    `${mipmap}/ic_launcher_monochrome.png`,
    density.foreground,
  );
  pngDimensions.set(`${drawable}/splashscreen_logo.png`, density.splash);
  pngDimensions.set(
    `${drawableNight}/splashscreen_logo.png`,
    density.splash,
  );
  pngDimensions.set(
    `${drawable}/notification_icon.png`,
    density.notification,
  );

  if (existsSync(absolute(mipmap))) {
    for (const filename of readdirSync(absolute(mipmap))) {
      if (filename.endsWith('.webp')) {
        fail(`Legacy duplicate Android resource remains: ${mipmap}/${filename}`);
      }
    }
  }
}

const decodedPngs = new Map();
for (const [relativePath, expectedSize] of pngDimensions) {
  if (!requireFile(relativePath)) continue;
  try {
    const png = PNG.sync.read(readFileSync(absolute(relativePath)));
    decodedPngs.set(relativePath, png);
    if (png.width !== expectedSize || png.height !== expectedSize) {
      fail(
        `${relativePath} is ${png.width}x${png.height}; expected ${expectedSize}x${expectedSize}`,
      );
    }
  } catch (error) {
    fail(`${relativePath} is not a readable PNG: ${error.message}`);
  }
}

const opaqueIconPaths = [
  'assets/icon.png',
  'assets/icon-dark.png',
  'assets/icon-tinted.png',
  `${iosIconRoot}/App-Icon-1024x1024@1x.png`,
  `${iosIconRoot}/App-Icon-dark-1024x1024@1x.png`,
  `${iosIconRoot}/App-Icon-tinted-1024x1024@1x.png`,
];

for (const relativePath of opaqueIconPaths) {
  const png = decodedPngs.get(relativePath);
  if (!png) continue;
  for (let index = 3; index < png.data.length; index += 4) {
    if (png.data[index] !== 255) {
      fail(`${relativePath} contains alpha; iOS app icons must be opaque`);
      break;
    }
  }
}

const hexToRgb = (hex) => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

const sample = (png, x, y) => {
  const offset = (y * png.width + x) * 4;
  return [...png.data.subarray(offset, offset + 3)];
};

const closeTo = (actual, expected, tolerance = 12) =>
  actual.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance);

const mainIcon = decodedPngs.get('assets/icon.png');
if (mainIcon) {
  const corner = sample(mainIcon, 8, 8);
  const center = sample(mainIcon, 512, 512);
  if (!closeTo(corner, hexToRgb('#2A0B40'))) {
    fail(`assets/icon.png background is not ManaSplit Plum: ${corner.join(',')}`);
  }
  if (!closeTo(center, hexToRgb('#F5C15C'))) {
    fail(`assets/icon.png center is not Reversed Gold: ${center.join(',')}`);
  }
}

const validateAssetCatalog = (relativeContentsPath) => {
  if (!requireFile(relativeContentsPath)) return;
  try {
    const contents = JSON.parse(readFileSync(absolute(relativeContentsPath), 'utf8'));
    for (const image of contents.images ?? []) {
      if (!image.filename) continue;
      const relativeAssetPath = join(
        dirname(relativeContentsPath),
        image.filename,
      );
      requireFile(relativeAssetPath);
    }
  } catch (error) {
    fail(`${relativeContentsPath} is invalid JSON: ${error.message}`);
  }
};

validateAssetCatalog(`${iosIconRoot}/Contents.json`);
validateAssetCatalog(`${iosSplashRoot}/Contents.json`);

const appConfig = readFileSync(absolute('app.config.ts'), 'utf8');
for (const requiredReference of [
  './assets/icon.png',
  './assets/icon-dark.png',
  './assets/icon-tinted.png',
  './assets/adaptive-icon.png',
  './assets/adaptive-icon-monochrome.png',
  './assets/splash-icon.png',
  './assets/splash-icon-dark.png',
  './assets/notification-icon.png',
]) {
  if (!appConfig.includes(requiredReference)) {
    fail(`app.config.ts does not reference ${requiredReference}`);
  }
}

if (failures.length > 0) {
  console.error('ManaSplit brand validation failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `ManaSplit brand validation passed (${Object.keys(sourceChecksums).length} canonical sources, ${pngDimensions.size} PNGs).`,
);
