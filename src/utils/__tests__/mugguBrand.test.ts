import {
  MUGGU_CENTER_STAGE,
  MUGGU_DOTS,
  MUGGU_DOT_STAGES,
  MUGGU_PETAL_STAGES,
  MUGGU_VIEWBOX,
} from '@/components/brand/mugguGeometry';
import { brand, mugguMotion } from '@/theme/brand';
import { describe, expect, it } from 'vitest';

const milliseconds = (progress: number) => progress * mugguMotion.cycleMs;

describe('ManaSplit muggu identity', () => {
  it('keeps brand colors fixed and separate from semantic theme colors', () => {
    expect(brand).toEqual({
      ink: '#3B1259',
      plum: '#2A0B40',
      deep: '#1B0730',
      gold: '#E8A13D',
      cream: '#FBF7F0',
      reversedGold: '#F5C15C',
      reversedInk: '#E9D5FF',
    });
    expect(new Set(Object.values(brand))).toHaveLength(7);
  });

  it('draws four non-overlapping petals before the center and dots', () => {
    expect(MUGGU_PETAL_STAGES).toHaveLength(4);

    for (const [index, stage] of MUGGU_PETAL_STAGES.entries()) {
      expect(stage.longStart).toBeLessThan(stage.longEnd);
      expect(stage.longEnd).toBe(stage.shortStart);
      expect(stage.shortStart).toBeLessThan(stage.shortEnd);

      const next = MUGGU_PETAL_STAGES[index + 1];
      if (next) expect(stage.shortEnd).toBeLessThan(next.longStart);
    }

    expect(MUGGU_PETAL_STAGES.at(-1)?.shortEnd).toBeLessThan(
      MUGGU_CENTER_STAGE.start,
    );
    expect(MUGGU_CENTER_STAGE.end).toBeLessThan(MUGGU_DOT_STAGES[0].start);
  });

  it('matches the approved 5.5 second motion landmarks', () => {
    expect(milliseconds(MUGGU_PETAL_STAGES[0].longEnd)).toBeCloseTo(552, 0);
    expect(milliseconds(MUGGU_PETAL_STAGES[1].longStart)).toBeCloseTo(780, 0);
    expect(milliseconds(MUGGU_CENTER_STAGE.start)).toBeCloseTo(3140, 0);
    expect(milliseconds(MUGGU_DOT_STAGES[0].start)).toBeCloseTo(3380, 0);
    expect(milliseconds(MUGGU_DOT_STAGES.at(-1)!.end)).toBeCloseTo(4100, 0);
    expect(milliseconds(mugguMotion.fadeStartProgress)).toBeCloseTo(5050, 0);
  });

  it('keeps every decorative dot inside the 120 unit view box', () => {
    expect(MUGGU_DOTS).toHaveLength(4);
    for (const dot of MUGGU_DOTS) {
      expect(dot.cx).toBeGreaterThan(0);
      expect(dot.cx).toBeLessThan(MUGGU_VIEWBOX);
      expect(dot.cy).toBeGreaterThan(0);
      expect(dot.cy).toBeLessThan(MUGGU_VIEWBOX);
    }
  });
});
