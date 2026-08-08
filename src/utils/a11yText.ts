// Text-scaling policy, in one place.
//
// The rule this app follows (user decision, 2026-08-07): CONTENT scales
// without a cap and the layout adapts around it; only fixed-geometry CHROME
// is capped. That mirrors what Apple's own apps do — Messages lets a message
// bubble grow without limit and restacks the row, but the tab bar label and
// the avatar monogram stop scaling, because a 2× monogram cannot fit a 40pt
// circle and a 2× tab label cannot fit a tab.
//
// So: never reach for a cap to make something "fit". Reach for it only when
// the element's geometry is genuinely fixed by design, and say why.

/**
 * Past this OS text scale, single-line horizontal rows stop fitting and must
 * restack vertically. 1.35 is where a name + amount + chevron stops leaving
 * usable width for the name on a 390pt-wide phone.
 */
export const STACK_AT_FONT_SCALE = 1.35;

/** True when the user is at an accessibility text size and layout must adapt. */
export const isAccessibilityTextSize = (fontScale: number) =>
  fontScale >= STACK_AT_FONT_SCALE;

/**
 * Caps for genuinely fixed-geometry chrome ONLY. Each is a container whose
 * size cannot follow the text.
 */
export const FONT_CAP = {
  /** Monogram inside a fixed-diameter avatar circle. Scaling it clips the
   *  initials to "B…" (observed on a Pixel 7 at 2×). */
  avatarMonogram: 1,
  /** Count badges pinned to a fixed-size dot (unread, filter count). */
  badge: 1.1,
  /** Tab bar labels: the tab width is fixed by the bar, and the icon above
   *  carries the meaning. Apple caps these too. */
  tabLabel: 1.2,
} as const;
