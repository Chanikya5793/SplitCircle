import AsyncStorage from '@react-native-async-storage/async-storage';

type StoredValue = string | object | null;

/**
 * Save a value under a given key.
 */
export async function setItem(key: string, value: StoredValue): Promise<void> {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  await AsyncStorage.setItem(key, json);
}

/**
 * Retrieve a value for a given key.
 */
export async function getItem<T = any>(key: string): Promise<T | null> {
  const json = await AsyncStorage.getItem(key);
  if (json === null) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    // Fallback for plain strings
    return (json as unknown) as T;
  }
}

/**
 * Remove a key/value pair.
 */
export async function removeItem(key: string): Promise<void> {
  await AsyncStorage.removeItem(key);
}

/**
 * Append an item to an array stored under `key`.
 * If the key does not exist, it creates a new array.
 */
export async function pushToArray<T>(key: string, item: T): Promise<void> {
  const existing = await getItem<T[]>(key);
  const updated = existing ? [...existing, item] : [item];
  await setItem(key, updated);
}

/**
 * Update an item in an array by its `id` field.
 */
export async function updateInArray<T extends { id: string }>(
  key: string,
  id: string,
  updater: (item: T) => T
): Promise<void> {
  const existing = await getItem<T[]>(key);
  if (!existing) return;
  const updated = existing.map((it) => (it.id === id ? updater(it) : it));
  await setItem(key, updated);
}
