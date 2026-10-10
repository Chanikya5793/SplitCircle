import { describe, expect, it } from 'vitest';
import { resolveInitials } from '../identity';

describe('resolveInitials', () => {
  it('uses first and last initials for people', () => {
    expect(resolveInitials('Taylor Tester')).toBe('TT');
    expect(resolveInitials('Alexandria Montgomery-Fitzgerald')).toBe('AM');
    expect(resolveInitials('Leo García')).toBe('LG');
  });

  it('ignores a trailing year or number in group names', () => {
    expect(resolveInitials('Goa Trip 2026')).toBe('GT');
    expect(resolveInitials('Sunday Brunch Club & Occasional Karaoke Night Crew')).toBe('SC');
  });

  it('keeps sensible fallbacks', () => {
    expect(resolveInitials('Apartment 4B')).toBe('A4');
    expect(resolveInitials('Rent')).toBe('RE');
    expect(resolveInitials('   ')).toBe('?');
    expect(resolveInitials(null, '—')).toBe('—');
  });
});
