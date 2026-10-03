// Guards the readable screen-edge contract in DESIGN.md.
//
// Flat GlassCard sections deliberately discard their horizontal padding. The
// screen gutter therefore remains the source of readable spacing. `fullBleed`
// is a narrow exception for row chrome, whose nested row restores the inset.
// Keep the exception list explicit so a content card cannot silently put copy
// at x=0 by importing the same negative margin.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { fullBleed, readableHorizontalInsets, SCREEN_GUTTER } from '@/components/ui/layout';

const SRC = join(process.cwd(), 'src');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.tsx')) out.push(full);
  }
  return out;
};

const importsFullBleed = (source: string): boolean =>
  /import\s*\{[^}]*\bfullBleed\b[^}]*\}\s*from/s.test(source);

const ROW_CHROME_ALLOWLIST = [
  'components/ChatThreadRow.tsx',
  'components/SettlementCard.tsx',
  'components/SwipeableExpenseCard.tsx',
  'components/SwipeableGroupCard.tsx',
  'screens/calls/CallHistoryScreen.tsx',
  'screens/groups/GroupListScreen.tsx',
  'screens/security/SecurityCenterScreen.tsx',
  'screens/settings/SettingsScreen.tsx',
].sort();

describe('screen-edge layout contract', () => {
  it('cancels exactly one readable gutter for deliberate row chrome', () => {
    expect(SCREEN_GUTTER).toBeGreaterThanOrEqual(16);
    expect(fullBleed).toEqual({ marginHorizontal: -SCREEN_GUTTER });
  });

  it('places the readable gutter inside portrait and landscape safe areas', () => {
    expect(readableHorizontalInsets(0, 0)).toEqual({
      paddingLeft: SCREEN_GUTTER,
      paddingRight: SCREEN_GUTTER,
    });
    expect(readableHorizontalInsets(47, 21)).toEqual({
      paddingLeft: 47 + SCREEN_GUTTER,
      paddingRight: 21 + SCREEN_GUTTER,
    });
  });

  it('reserves fullBleed imports for reviewed row-list implementations', () => {
    const users = walk(SRC)
      .filter((file) => importsFullBleed(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file))
      .sort();

    expect(users).toEqual(ROW_CHROME_ALLOWLIST);
  });
});
