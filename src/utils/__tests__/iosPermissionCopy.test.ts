import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const config = readFileSync(new URL('../../../app.config.ts', import.meta.url), 'utf8');
const plist = readFileSync(new URL('../../../ios/SplitCircle/Info.plist', import.meta.url), 'utf8');

describe('iOS permission explanations', () => {
  it.each([
    ['NSPhotoLibraryUsageDescription', 'receipt', 'chat'],
    ['NSCameraUsageDescription', 'receipt', 'video calls'],
    ['NSMicrophoneUsageDescription', 'voice message', 'video calls'],
  ])('%s describes a real use and example in both config sources', (key, example, feature) => {
    const nativeValue = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1];
    const configValue = config.match(new RegExp(`${key}: '([^']+)'`))?.[1];
    expect(nativeValue).toBeDefined();
    expect(configValue).toBe(nativeValue);
    expect(nativeValue).toContain('For example,');
    expect(nativeValue).toContain(example);
    expect(nativeValue).toContain(feature);
    expect(nativeValue).not.toMatch(/^Allow .* to access/);
  });
});
