import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateSiriShortcutParameters = vi.fn();
vi.mock('../../../modules/splitcircle-ai', () => ({
  updateSiriShortcutParameters: (...a: unknown[]) => updateSiriShortcutParameters(...a),
}));
vi.mock('@/services/widgetService', () => ({ publishWidgetSnapshot: vi.fn() }));
vi.mock('@/services/aiIndexStore', () => ({ upsertGroupMeta: vi.fn(), pruneGroupMeta: vi.fn() }));
vi.mock('@/utils/storage', () => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }));

import { clearCachedGroups, persistGroups } from '../groupCache';
import { publishWidgetSnapshot } from '@/services/widgetService';

const groups = [{ groupId: 'g1', name: 'Tahoe', members: [{ userId: 'u1' }] }] as any;
beforeEach(() => vi.clearAllMocks());

describe('Siri shortcut-parameter refresh wiring (Gap 1)', () => {
  it('persistGroups refreshes Siri params alongside the widget snapshot', async () => {
    await persistGroups('u1', groups);
    expect(publishWidgetSnapshot).toHaveBeenCalledWith('u1', groups);
    expect(updateSiriShortcutParameters).toHaveBeenCalledTimes(1);
  });
  it('clearCachedGroups refreshes Siri params (drops a signed-out user\'s groups)', async () => {
    await clearCachedGroups('u1');
    expect(updateSiriShortcutParameters).toHaveBeenCalledTimes(1);
  });
  it('a throw from the refresh never rejects persistGroups (best-effort contract)', async () => {
    updateSiriShortcutParameters.mockImplementationOnce(() => { throw new Error('native boom'); });
    await expect(persistGroups('u1', groups)).resolves.toBeUndefined();
  });
  it('no-ops without a userId', async () => {
    await persistGroups('', groups);
    expect(updateSiriShortcutParameters).not.toHaveBeenCalled();
  });
});
