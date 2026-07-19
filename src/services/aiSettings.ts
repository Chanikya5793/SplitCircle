/**
 * aiSettings.ts — user-facing AI preferences.
 *
 * Private Cloud Compute escalation is ON by default (Apple's attested cloud,
 * same privacy story Apple Intelligence uses system-wide; answers carry a
 * visible PCC badge). Users who want strictly on-device answers flip the
 * switch off in Settings → AI. Persisted in AsyncStorage; reads are cached so
 * the pipeline can consult it synchronously after first load.
 */

import { getItem, setItem } from '@/utils/storage';

const PCC_KEY = 'ai_pcc_enabled_v1';

let cached: boolean | null = null;

/** Whether PCC escalation is allowed. Defaults to true until the user opts out. */
export async function isPccEnabled(): Promise<boolean> {
  if (cached != null) return cached;
  try {
    const stored = await getItem<{ enabled: boolean }>(PCC_KEY);
    cached = stored == null ? true : stored.enabled === true;
  } catch {
    cached = true;
  }
  return cached;
}

export async function setPccEnabled(enabled: boolean): Promise<void> {
  cached = enabled;
  try {
    await setItem(PCC_KEY, { enabled });
  } catch {
    // Preference persists best-effort; the cached value still applies this run.
  }
}
