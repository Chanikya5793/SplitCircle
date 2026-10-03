import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  auth: { user: { userId: 'google-user' } as { userId: string } | null, sessionAuthenticated: true },
  signOut: vi.fn(async () => undefined),
  wipe: vi.fn(async () => undefined),
  subscribe: vi.fn(),
  callbacks: [] as Array<(record: any) => void>,
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ ...harness.auth, signOutUser: harness.signOut }),
}));
vi.mock('@/services/pairingService', () => ({
  getCurrentDeviceId: vi.fn(async () => 'this-device'),
  revokeDevice: vi.fn(async () => undefined),
  subscribeToOwnPairedDevice: harness.subscribe,
}));
vi.mock('@/services/deviceSyncCoordinator', () => ({ resetHandoffState: vi.fn(async () => undefined) }));
vi.mock('@/utils/haptics', () => ({ errorHaptic: vi.fn() }));
vi.mock('../../../modules/splitcircle-crypto', () => ({ wipeSignalState: harness.wipe }));
vi.mock('@/components/LiquidBackground', () => ({ LiquidBackground: ({ children }: any) => <>{children}</> }));
vi.mock('@/components/ui/DeviceSetupChoice', () => ({ DeviceSetupChoice: () => null }));

import { PendingPairingGate } from '../ui/PendingPairingGate';

beforeEach(() => {
  harness.auth.user = { userId: 'google-user' };
  harness.auth.sessionAuthenticated = true;
  harness.signOut.mockClear();
  harness.wipe.mockClear();
  harness.callbacks.length = 0;
  harness.subscribe.mockReset().mockImplementation((_userId, _deviceId, onChange) => {
    harness.callbacks.push(onChange);
    return () => undefined;
  });
});
afterEach(cleanup);

it('does not treat the next sign-in initial missing pairing record as revocation', async () => {
  const view = render(<PendingPairingGate />);
  await act(async () => { await Promise.resolve(); });
  expect(harness.callbacks).toHaveLength(1);

  await act(async () => { harness.callbacks[0]({ pairingStatus: 'confirmed' }); });
  harness.auth.sessionAuthenticated = false;
  view.rerender(<PendingPairingGate />);
  harness.auth.sessionAuthenticated = true;
  view.rerender(<PendingPairingGate />);
  await act(async () => { await Promise.resolve(); });
  expect(harness.callbacks).toHaveLength(2);

  await act(async () => { harness.callbacks[1](null); });
  expect(harness.wipe).not.toHaveBeenCalled();
  expect(harness.signOut).not.toHaveBeenCalled();
});
