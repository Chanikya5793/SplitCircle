// Guards the Phase 2 surface-role classification (doc 37).
//
// In flat surface mode a GlassCard/GlassView defaults to role="section" and
// renders BORDERLESS — no fill, no border. That is right for a content card and
// catastrophic for chrome: a bottom sheet or menu with no fill is unreadable
// text sitting on top of whatever is scrolling behind it.
//
// Nothing in the type system can catch that, because the default is valid.
// This test does it structurally instead: any glass surface rendered inside a
// <Modal> is chrome by construction, so it must EITHER be marked
// role="floating" itself OR be nested inside a surface that is (content cards
// inside a sheet legitimately go borderless on top of the sheet's own fill).
//
// Source-scanning rather than render-based on purpose — it needs to cover all
// 244 call sites across 88 files, which no component test could reach.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.tsx')) out.push(full);
  }
  return out;
};

interface GlassTag {
  start: number;
  end: number;
  floating: boolean;
  selfClosing: boolean;
  line: number;
}

/** Every <GlassCard>/<GlassView> opening tag in source order. */
const glassTags = (src: string): GlassTag[] => {
  const re = /<(GlassCard|GlassView)\b([^>]*?)(\/?)>/gs;
  const tags: GlassTag[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) {
    tags.push({
      start: m.index,
      end: m.index + m[0].length,
      floating: /\brole=["'{]?\s*["']?floating/.test(m[2]),
      selfClosing: m[3] === '/',
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return tags;
};

/** Character ranges covered by a <Modal> … </Modal> block. */
const modalRanges = (src: string): [number, number][] => {
  const ranges: [number, number][] = [];
  for (let om = /<Modal\b/g.exec(src); om; ) {
    const open = om.index;
    let depth = 0;
    let i = open;
    while (i < src.length) {
      if (src.startsWith('<Modal', i)) {
        depth += 1;
        i += 6;
        continue;
      }
      if (src.startsWith('</Modal>', i)) {
        depth -= 1;
        i += 8;
        if (depth === 0) {
          ranges.push([open, i]);
          break;
        }
        continue;
      }
      i += 1;
    }
    const re = /<Modal\b/g;
    re.lastIndex = i;
    om = re.exec(src);
  }
  return ranges;
};

/**
 * Glass tags inside a Modal that are neither floating themselves nor enclosed
 * by a floating glass ancestor. Walks a real open/close stack so nesting is
 * resolved rather than guessed.
 */
const unprotectedChrome = (src: string): number[] => {
  const tags = glassTags(src);
  const modals = modalRanges(src);
  if (!modals.length || !tags.length) return [];

  const closeRe = /<\/(GlassCard|GlassView)>/g;
  const closes: number[] = [];
  for (let m = closeRe.exec(src); m; m = closeRe.exec(src)) closes.push(m.index);

  // Merge opens and closes into one ordered event stream.
  type Ev = { pos: number; open?: GlassTag };
  const events: Ev[] = [
    ...tags.map((t) => ({ pos: t.start, open: t })),
    ...closes.map((pos) => ({ pos })),
  ].sort((a, b) => a.pos - b.pos);

  const stack: GlassTag[] = [];
  const bad: number[] = [];
  for (const ev of events) {
    if (ev.open) {
      const inModal = modals.some(([a, b]) => ev.open!.start >= a && ev.open!.start <= b);
      const covered = ev.open.floating || stack.some((t) => t.floating);
      if (inModal && !covered) bad.push(ev.open.line);
      if (!ev.open.selfClosing) stack.push(ev.open);
    } else {
      stack.pop();
    }
  }
  return bad;
};

describe('surface role coverage', () => {
  const files = walk(SRC);

  it('finds the glass surfaces it is meant to be checking', () => {
    // Guards against the scan silently matching nothing after a refactor —
    // a test that checks 0 call sites would pass forever while proving nothing.
    const total = files.reduce((n, f) => n + glassTags(readFileSync(f, 'utf8')).length, 0);
    expect(total).toBeGreaterThan(200);
  });

  it('marks a meaningful number of surfaces as floating chrome', () => {
    const floating = files.reduce(
      (n, f) => n + glassTags(readFileSync(f, 'utf8')).filter((t) => t.floating).length,
      0,
    );
    expect(floating).toBeGreaterThan(50);
  });

  it('blur is confined to the two sanctioned primitives', () => {
    // DESIGN.md forbids hand-rolling BlurView outside GlassCard, carving out
    // full-bleed scrims. Phase 3 gave those scrims their own primitive
    // (ScrimBackdrop), so the carve-out no longer needs to be a judgement call
    // — blur now lives in exactly two files, and that is checkable.
    //
    // It also matters for flat mode: a stray BlurView renders a glass surface
    // that surfaceStyle cannot reach, so flat mode would look inconsistent in
    // one spot with nothing to explain why.
    const ALLOWED = ['ui/GlassCard.tsx', 'ui/ScrimBackdrop.tsx'];
    const offenders = files
      .filter((f) => /from ['"]expo-blur['"]/.test(readFileSync(f, 'utf8')))
      .filter((f) => !ALLOWED.some((a) => f.endsWith(a)))
      .map((f) => f.replace(SRC, 'src'));
    expect(offenders).toEqual([]);
  });

  it('every glass surface inside a Modal is floating, or nested inside one that is', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const lines = unprotectedChrome(readFileSync(f, 'utf8'));
      for (const l of lines) offenders.push(`${f.replace(SRC, 'src')}:${l}`);
    }
    // A failure here means: you added a sheet/menu/dialog that will render with
    // NO background in flat mode. Add role="floating" to it (see
    // src/components/ui/surfaceRole.ts).
    expect(offenders).toEqual([]);
  });
});
