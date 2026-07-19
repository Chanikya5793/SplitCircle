/**
 * In-memory stand-in for expo-sqlite in node tests. aiIndexStore guards every
 * SQLite touch and degrades to in-memory compute when the DB can't open —
 * throwing here exercises exactly that production fallback path.
 */
export const openDatabaseSync = (): never => {
  throw new Error('expo-sqlite is not available in node tests');
};

export default { openDatabaseSync };
