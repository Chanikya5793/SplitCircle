// Server-side mirror of src/utils/identity.ts (doc 30) — functions/ is a
// separate TS project with no shared import path to src/, so this is a
// deliberate minimal duplicate, not drift. Keep both in sync by hand.

type NameSource = { displayName?: string | null; email?: string | null } | null | undefined;

export const resolveDisplayName = (source: NameSource, fallback = 'Someone'): string => {
  const name = source?.displayName?.trim();
  return name ? name : fallback;
};

export const resolveInitials = (name?: string | null, fallback = '?'): string => {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return fallback;
};
