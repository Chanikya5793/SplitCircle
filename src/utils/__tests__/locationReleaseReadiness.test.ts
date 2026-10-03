import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const picker = readFileSync(resolve(process.cwd(), 'src/components/Chat/LocationPicker.tsx'), 'utf8');

describe('production location sharing', () => {
  it('keeps the implemented location-pin send action', () => {
    expect(picker).toContain('onPress={handleSend}');
    expect(picker).toContain('Send this location');
    expect(picker).toContain('onSendLocation(');
  });

  it('does not advertise unfinished live sharing or request background access', () => {
    expect(picker).not.toMatch(/Coming Soon|handleLiveLocation|Share live location/);
    expect(picker).not.toMatch(/(?:request|get)BackgroundPermissionsAsync/);
  });
});
