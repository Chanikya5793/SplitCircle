/**
 * What a glass/flat surface IS, structurally. Consumed by GlassCard (and the
 * deprecated GlassView shim) and ignored entirely in glass mode — the shipping
 * liquid-glass UI renders identically whatever the role says.
 *
 *   'section'  — a content card: a stats block, a settings group, a summary.
 *                Goes fully borderless in flat mode (no fill, no border, no
 *                radius) and is grouped by section labels and dividers.
 *   'floating' — chrome that sits OFF the canvas and must stay readable
 *                without a card edge to define it: bottom sheets, toasts,
 *                menus, dropdowns, autocompletes, circular icon buttons,
 *                sticky header pills, modals. These keep an opaque fill and a
 *                hairline in flat mode.
 *   'glass'    - a deliberate material accent retained under Flat.
 *                Reduce Transparency still replaces it with an opaque card.
 *                Uses the native/blur/Android material branch; Flat still
 *                resolves compact radii and opaque fallback tints.
 *                For the named accents in DESIGN.md (group header, debts,
 *                friend hero/balance and SegmentedControl) that should read as
 *                glass even in an otherwise borderless, no-card flat UI. Use
 *                sparingly — this is an accent, not the default treatment.
 *
 * Rule of thumb: if removing the surface entirely would leave the content
 * floating over unrelated scrolling content, it is 'floating'. If a designer
 * has explicitly called it out as a glass accent, it is 'glass'. Otherwise
 * 'section'.
 */
export type SurfaceRole = 'section' | 'floating' | 'glass';
