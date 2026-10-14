/**
 * Offline grace: when the access service can't be reached, local metered
 * features run a few times a day — not without limit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/navigation/navigationRef', () => ({ navigationRef: { isReady: () => false } }));
vi.mock('@/services/monetizationService', () => ({ authorizeMonetizedOperation: vi.fn() }));
vi.mock('@/services/monetizedOperationFinalizationQueue', () => ({ queueMonetizedOperationFinalization: vi.fn() }));
vi.mock('@/utils/appAlert', () => ({ appAlert: vi.fn() }));
vi.mock('@/utils/monetizationPresentation', () => ({ describeResetTime: () => 'soon' }));
vi.mock('@/constants/routes', () => ({ ROUTES: { APP: { PLANS_AND_CREDITS: 'p', USAGE: 'u' } } }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { OFFLINE_GRACE_PER_DAY, requestMeteredAccess, takeOfflineGrace } from '../meteredAccess';
import { authorizeMonetizedOperation } from '@/services/monetizationService';
import { appAlert } from '@/utils/appAlert';

beforeEach(async () => {
  await AsyncStorage.clear();
  vi.mocked(appAlert).mockClear();
});

describe('offline grace', () => {
  it('allows only the daily grace per feature', async () => {
    const limit = OFFLINE_GRACE_PER_DAY['ai.expense_on_device_turn'];
    for (let i = 0; i < limit; i += 1) expect(await takeOfflineGrace('ai.expense_on_device_turn')).toBe(true);
    expect(await takeOfflineGrace('ai.expense_on_device_turn')).toBe(false);
    // Separate per feature.
    expect(await takeOfflineGrace('advanced_split.completion')).toBe(true);
  });

  it('blocks and explains once the grace is used while the service is unreachable', async () => {
    vi.mocked(authorizeMonetizedOperation).mockRejectedValue(Object.assign(new Error('offline'), { code: 'unavailable' }));
    const ask = () => requestMeteredAccess({ ownerUid: 'u1', featureId: 'insights.advanced_report', executionRoute: 'on_device_apple' });
    expect(await ask()).not.toBeNull();
    expect(await ask()).toBeNull();
    expect(vi.mocked(appAlert).mock.calls.at(-1)?.[0]).toBe('Connect to keep going');
  });

  it('does not cap Max subscribers offline', async () => {
    vi.mocked(authorizeMonetizedOperation).mockResolvedValueOnce({
      allowed: true, authorizationId: 'a', planId: 'max',
    } as never);
    await requestMeteredAccess({ ownerUid: 'u1', featureId: 'insights.advanced_report', executionRoute: 'on_device_apple' });
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 10; i += 1) expect(await takeOfflineGrace('insights.advanced_report')).toBe(true);
  });
});
