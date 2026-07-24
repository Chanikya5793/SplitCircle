// Universal identity fallbacks (doc 30). Sign in with Apple sends the user's
// name exactly once, ever, per Apple ID<->app pair — a missed or raced capture
// (see AuthContext.tsx's signInWithApple) leaves displayName permanently ''.
// buildUserProfile produces a literal '' (not null/undefined), so `?? 'X'`
// never fires for it — always use these, never hand-roll another `|| 'X'` /
// `?? 'X'` at a new call site.

type NameSource = { displayName?: string | null; email?: string | null } | null | undefined;

/**
 * Never persist this fallback into Firestore/RTDB as if it were the user's
 * real name — call this at render/interpolation time only. Guessing a name
 * from an email and writing it as fact into money-attribution history is
 * worse than a clearly-marked placeholder (doc 30's explicit rejection).
 */
export const resolveDisplayName = (source: NameSource, fallback = 'Someone'): string => {
  const name = source?.displayName?.trim();
  return name ? name : fallback;
};

/** True whenever a user's own name hasn't been captured/set yet. */
export const needsDisplayName = (source: NameSource): boolean => !source?.displayName?.trim();

/**
 * Moved from AvatarPhoto.tsx's local initialsFor (same logic, now shared) —
 * first+last initial for 2+ words, first two chars for one word, '?' if
 * there's no name to work with at all.
 */
export const resolveInitials = (name?: string | null, fallback = '?'): string => {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return fallback;
};
