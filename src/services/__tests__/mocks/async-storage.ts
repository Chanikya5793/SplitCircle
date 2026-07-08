/**
 * In-memory mock for @react-native-async-storage/async-storage
 * (vitest.services.config.ts aliases the package here). The real package's
 * web fallback touches `window.localStorage`, which does not exist in the
 * node test environment — every call would reject with
 * `ReferenceError: window is not defined`, making persistence-dependent
 * tests (crash-safe outgoing-call UUID records) timing-dependent and flaky.
 *
 * The backing store lives on `globalThis.__nativeCallTestMocks` (created by
 * the setup file, reused here) so it SURVIVES vi.resetModules() — exactly
 * like real AsyncStorage survives an app relaunch. Tests simulate a
 * force-kill + relaunch by resetting modules without clearing the store, and
 * a truly fresh install by calling __clearAsyncStorageStore() (or
 * `mocks.asyncStorageStore.clear()`) in beforeEach.
 */

const registry = ((globalThis as Record<string, unknown>).__nativeCallTestMocks ??= {}) as Record<
  string,
  unknown
>;
const store = (registry.asyncStorageStore ??= new Map<string, string>()) as Map<string, string>;

const AsyncStorageMock = {
  getItem: async (key: string): Promise<string | null> => store.get(key) ?? null,
  setItem: async (key: string, value: string): Promise<void> => {
    store.set(key, value);
  },
  removeItem: async (key: string): Promise<void> => {
    store.delete(key);
  },
  clear: async (): Promise<void> => {
    store.clear();
  },
  getAllKeys: async (): Promise<string[]> => Array.from(store.keys()),
  multiGet: async (keys: string[]): Promise<Array<[string, string | null]>> =>
    keys.map((key) => [key, store.get(key) ?? null]),
  multiSet: async (pairs: Array<[string, string]>): Promise<void> => {
    for (const [key, value] of pairs) {
      store.set(key, value);
    }
  },
  multiRemove: async (keys: string[]): Promise<void> => {
    for (const key of keys) {
      store.delete(key);
    }
  },
};

export const __asyncStorageStore = store;
export const __clearAsyncStorageStore = () => store.clear();

export default AsyncStorageMock;
