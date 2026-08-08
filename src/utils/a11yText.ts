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
 * The width a row's content effectively gets once the text has been scaled up:
 * the screen is fixed, so a 1.3× text size leaves 1/1.3 of the usable columns.
 */
const effectiveWidth = (windowWidth: number, fontScale: number) =>
  windowWidth / Math.max(fontScale, 1);

/**
 * Below this many effective points, a name + amount + chevron row cannot hold
 * its own on one line and has to restack. Derived from the two real cases:
 * an iPhone 17 Pro (402pt) at iOS's XXL (1.235) lands at 325 and overflows —
 * money truncated to "€495…", the title clipped mid-word — while a Pixel 7
 * (485dp) at 1.3 lands at 373 and is comfortably fine.
 */
const MIN_ROW_WIDTH = 370;

/**
 * Whether a horizontal row must restack, given BOTH the text scale and the
 * screen width.
 *
 * A bare scale threshold is not enough, and shipping one is what let this
 * regress (2026-08-08). `STACK_AT_FONT_SCALE` sits at 1.35 — which on iOS is
 * the top of the NON-accessibility ladder (XXXL = 1.353). The two sizes just
 * below it, XL (1.118) and XXL (1.235), are ordinary choices people make from
 * Settings › Display, and they fell in a band with no handling at all: too big
 * to fit, not big enough to restack, so rows simply overflowed. It went unseen
 * because the Android device used for testing is 485dp wide and absorbs that
 * band; a 402pt iPhone does not. Width is half the problem, so width belongs
 * in the condition.
 */
export const shouldStackRow = (fontScale: number, windowWidth: number) =>
  isAccessibilityTextSize(fontScale) ||
  effectiveWidth(windowWidth, fontScale) < MIN_ROW_WIDTH;

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
