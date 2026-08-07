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
 *
 * Rule of thumb: if removing the surface entirely would leave the content
 * floating over unrelated scrolling content, it is 'floating'.
 */
export type SurfaceRole = 'section' | 'floating';
