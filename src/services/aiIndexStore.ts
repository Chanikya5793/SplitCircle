/**
 * aiIndexStore.ts — persistent, per-group on-device AI analytics index backed by
 * expo-sqlite. The deterministic analytics ("the index") used to live only in an
 * in-memory Map that died on every app restart; this persists it so the
 * assistant is instant and grounded from the very first question after a cold
 * launch.
 *
 * The staleness logic lives in the PURE `expenseAnalytics` module (which stays
 * free of native imports so it can be unit-tested). This service just plugs a
 * SQLite-backed persistence provider into it via `setIndexPersistence`. Every
 * SQLite call is guarded — any failure (locked/corrupt/unavailable DB, or web
 * where sync SQLite may be absent) leaves the provider degraded to a no-op and
 * `getGroupAnalytics` transparently falls back to in-memory compute, so the AI
 * path can never crash.
 */

import * as SQLite from 'expo-sqlite';
import {
  INDEX_VERSION,
  setIndexPersistence,
  type ExpenseAnalytics,
  type IndexPersistence,
  type StoredGroupIndex,
} from '@/utils/expenseAnalytics';

const DB_NAME = 'ai_index.db';
const TABLE = 'ai_index';

// Analytics are per-(group, user) because user share/balance are baked into
// them. One device usually has a single user, but we still key defensively to
// avoid cross-user bleed. The composite key is stored in the `groupId` PRIMARY
// KEY column so the schema stays exactly as specified.
const KEY_SEP = '::';
const rowKey = (groupId: string, userId: string): string => `${groupId}${KEY_SEP}${userId}`;

interface IndexRow {
  groupId: string; // composite rowKey
  version: number;
  updatedAt: number;
  expenseCount: number;
  analyticsJson: string;
}

/** Per-row store info for the Settings transparency screen. */
export interface StoredIndexEntry {
  groupId: string;
  userId: string;
  version: number;
  updatedAt: number;
  expenseCount: number;
  /** Serialized analytics size in bytes (cheap storage-footprint estimate). */
  bytes: number;
}

let db: SQLite.SQLiteDatabase | null = null;
let initFailed = false;

/** Lazily open + migrate the DB. Returns null (once) if SQLite is unavailable. */
function getDb(): SQLite.SQLiteDatabase | null {
  if (db) return db;
  if (initFailed) return null;
  try {
    const database = SQLite.openDatabaseSync(DB_NAME);
    database.execSync(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
        groupId TEXT PRIMARY KEY NOT NULL,
        version INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        expenseCount INTEGER NOT NULL,
        analyticsJson TEXT NOT NULL
      );`,
    );
    // Version bump ⇒ analytics shape changed ⇒ drop stale rows so they rebuild
    // lazily against the current INDEX_VERSION on next access.
    database.runSync(`DELETE FROM ${TABLE} WHERE version != ?;`, INDEX_VERSION);
    db = database;
    return db;
  } catch (e) {
    console.log('[aiIndexStore] SQLite init failed; using in-memory index only', e);
    initFailed = true;
    db = null;
    return null;
  }
}

const provider: IndexPersistence = {
  read(groupId: string, userId: string): StoredGroupIndex | null {
    const database = getDb();
    if (!database) return null;
    try {
      const row = database.getFirstSync<IndexRow>(
        `SELECT groupId, version, updatedAt, expenseCount, analyticsJson FROM ${TABLE} WHERE groupId = ?;`,
        rowKey(groupId, userId),
      );
      if (!row) return null;
      const analytics = JSON.parse(row.analyticsJson) as ExpenseAnalytics;
      return {
        version: row.version,
        updatedAt: row.updatedAt,
        expenseCount: row.expenseCount,
        analytics,
      };
    } catch (e) {
      console.log('[aiIndexStore] read failed', e);
      return null;
    }
  },

  write(groupId: string, userId: string, entry: StoredGroupIndex): void {
    const database = getDb();
    if (!database) return;
    try {
      database.runSync(
        `INSERT OR REPLACE INTO ${TABLE} (groupId, version, updatedAt, expenseCount, analyticsJson) VALUES (?, ?, ?, ?, ?);`,
        rowKey(groupId, userId),
        entry.version,
        entry.updatedAt,
        entry.expenseCount,
        JSON.stringify(entry.analytics),
      );
    } catch (e) {
      console.log('[aiIndexStore] write failed', e);
    }
  },

  clear(): void {
    const database = getDb();
    if (!database) return;
    try {
      database.runSync(`DELETE FROM ${TABLE};`);
    } catch (e) {
      console.log('[aiIndexStore] clear failed', e);
    }
  },
};

// Register on module load so any code path that imports this store (the on-device
// ask path, AiIndexScreen) wires persistence into the pure analytics module.
setIndexPersistence(provider);

/** All persisted index rows (per group + user) for the transparency screen. */
export function getIndexStoreEntries(): StoredIndexEntry[] {
  const database = getDb();
  if (!database) return [];
  try {
    const rows = database.getAllSync<IndexRow>(
      `SELECT groupId, version, updatedAt, expenseCount, analyticsJson FROM ${TABLE};`,
    );
    return rows.map((r) => {
      const sep = r.groupId.lastIndexOf(KEY_SEP);
      const groupId = sep >= 0 ? r.groupId.slice(0, sep) : r.groupId;
      const userId = sep >= 0 ? r.groupId.slice(sep + KEY_SEP.length) : '';
      return {
        groupId,
        userId,
        version: r.version,
        updatedAt: r.updatedAt,
        expenseCount: r.expenseCount,
        bytes: r.analyticsJson.length,
      };
    });
  } catch (e) {
    console.log('[aiIndexStore] list failed', e);
    return [];
  }
}

/** Approximate on-disk footprint of the index in bytes (0 when unavailable). */
export function getIndexStoreFootprint(): number {
  return getIndexStoreEntries().reduce((sum, e) => sum + e.bytes, 0);
}

/** Drop every persisted index row. Backs the "Rebuild index" action. */
export function clearIndexStore(): void {
  provider.clear();
}
