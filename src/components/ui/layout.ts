// Screen-edge layout constants.
//
// THE PROBLEM THESE EXIST TO FIX (2026-08-08). Flat mode makes list rows
// full-bleed so a row's press highlight and its dividers reach both screen
// edges, the way a native list behaves. The first way that was done was to
// drop the SCREEN's horizontal gutter in flat mode — and that is too blunt.
// A screen holds more than rows: a page title, a profile header, section
// labels, segmented controls, swatch strips, empty states. Removing the
// gutter pinned all of them to x=0, so on the Settings screen the word
// "Settings" started 1pt from the edge and the profile avatar was clipped by
// it.
//
// The right shape is the inverse: the screen ALWAYS keeps its gutter, and the
// few things that genuinely want to touch the edges break out of it with a
// negative margin. Full-bleed is the exception, declared where it applies,
// rather than the default that everything else has to defend against.
//
//   <ScrollView contentContainerStyle={styles.screen}>   // SCREEN_GUTTER
//     <Text>Title</Text>                                  // inset, correct
//     <GlassCard style={isFlat && fullBleed}>…rows…</GlassCard>
//   </ScrollView>
//
// Rows inside a bled-out card keep their text inset via their own padding
// (ListRow uses theme.spacing.md), so only the highlight and the hairline
// actually reach the edge.

/** Standard horizontal inset from the screen edge for readable content. */
export const SCREEN_GUTTER = 16;

/**
 * Cancels SCREEN_GUTTER so a row list can run edge to edge. Apply to the
 * CARD, not to the screen — and only in flat mode, where rows are borderless;
 * a glass card is a floating surface and must stay inset.
 */
export const fullBleed = { marginHorizontal: -SCREEN_GUTTER } as const;

/**
 * Clearance a screen's own large title needs below the safe area when the
 * native stack header is TRANSPARENT (`headerTransparent: true`) and empty
 * (`headerTitle: ''`).
 *
 * The header still draws its BACK BUTTON in that configuration, and it does so
 * over the screen's content. A title placed at `insets.top + 24` therefore
 * lands directly under the arrow — measured on a Pixel 7, "Friends" and
 * "Notifications" both had the glyph struck through their first letter. Tab
 * screens don't hit this because they have no back button, which is why the
 * same pattern looks fine on Expenses/Chats/Calls/Settings.
 */
export const TRANSPARENT_HEADER_CLEARANCE = 56;
