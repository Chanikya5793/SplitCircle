/**
 * App-wide "only one swipe row open at a time".
 *
 * Every swipeable row in this app (chat threads, groups, expenses,
 * settlements, recurring bills, search results) kept a private ref and closed
 * only ITSELF after its action ran. Nothing ever closed a row when a different
 * one opened, so swiping down a list left a trail of rows stuck open at once —
 * the actions read as permanent list chrome rather than a transient reveal,
 * and tapping a row underneath one hits the wrong target.
 *
 * A module-level registry rather than context or a prop: swipe rows live in
 * many unrelated lists across the app, and threading state through every one
 * of them would guarantee the next list forgets. There is only ever one open
 * row on screen, so one module-scoped slot models it exactly.
 *
 * Deliberately duck-typed on `close()` rather than importing Swipeable's type:
 * this file is then independent of which swipe implementation a given row
 * uses, so migrating a list to a different component (or to Reanimated's
 * newer Swipeable) does not require touching it.
 */

interface Closeable {
  close: () => void;
}

let openRow: Closeable | null = null;

/**
 * Call from `onSwipeableWillOpen`. Closes whichever row was open before.
 *
 * WILL_open, not DID_open, so the previous row starts closing in the same
 * frame as the new one starts opening — waiting until it has opened shows both
 * fully revealed for the duration of the animation.
 */
export const setOpenSwipeable = (row: Closeable | null): void => {
  if (!row) return;
  if (openRow && openRow !== row) {
    try {
      openRow.close();
    } catch {
      // An unmounted row (list re-rendered while open) can throw. Losing the
      // close is harmless — it is already gone from the screen.
    }
  }
  openRow = row;
};

/** Call from `onSwipeableClose`, so a closed row is not held as "the open one". */
export const clearOpenSwipeable = (row: Closeable | null): void => {
  if (row && openRow === row) openRow = null;
};

/**
 * Closes any open row. For navigating away, or any action that changes what
 * the list means — a stale reveal left behind on return is disorienting.
 */
export const closeOpenSwipeable = (): void => {
  if (!openRow) return;
  try {
    openRow.close();
  } catch {
    // Same as above.
  }
  openRow = null;
};
