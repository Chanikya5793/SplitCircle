import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlertButton } from 'react-native';
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), clear: vi.fn(), appAlert: vi.fn(), groups: [] }));
vi.mock('@/constants', () => ({ ROUTES: { APP: { AI_MEMORY: 'AiMemory', AI_EVALS: 'AiEvals' } } }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: mocks.navigate }) }));
vi.mock('@/components/GlassView', () => ({ GlassView: ({ children }: any) => <div>{children}</div> }));
vi.mock('@/components/LiquidBackground', () => ({ LiquidBackground: ({ children }: any) => <div>{children}</div> }));
vi.mock('@/components/ui', () => ({ GuardedScreen: ({ children }: any) => <div>{children}</div> }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { userId: 'test' } }) }));
vi.mock('@/context/GroupContext', () => ({ useGroups: () => ({ groups: mocks.groups }) }));
vi.mock('@/context/ThemeContext', () => ({ useTheme: () => ({ theme: { colors: {} } }) }));
vi.mock('@/services/onDeviceAiService', () => ({ getOnDeviceAiAvailability: () => 'available', ON_DEVICE_UNAVAILABLE_COPY: {} }));
vi.mock('@/services/aiIndexStore', () => ({ getIndexStoreEntries: () => [], getIndexStoreFootprint: () => 0 }));
vi.mock('@/services/aiFeedbackService', () => ({ clearFixtures: mocks.clear }));
vi.mock('@/utils/appAlert', () => ({ appAlert: mocks.appAlert }));
vi.mock('@/utils/expenseAnalytics', () => ({ clearAnalyticsCache: vi.fn(), computeIndexMeta: vi.fn(), getGroupAnalytics: vi.fn(), INDEX_VERSION: 1, isIndexFresh: vi.fn() }));
vi.mock('@/utils/haptics', () => ({ mediumHaptic: vi.fn(), successHaptic: vi.fn() }));
vi.mock('react-native-paper', () => ({
  Icon: () => null,
  Text: ({ children }: any) => <span>{children}</span>,
  Button: ({ children, onPress, accessibilityState }: any) => <button onClick={onPress} aria-expanded={accessibilityState?.expanded}>{children}</button>,
}));
import { AiIndexScreen } from '../AiIndexScreen';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.clear.mockReset();
  mocks.appAlert.mockReset();
});
describe('consumer AI controls', () => {
  it('keeps memory available and diagnostics collapsed without exposing evaluations in release', () => {
    render(<AiIndexScreen />);
    expect(screen.queryByText('Rebuild index')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'AI memory' }));
    expect(mocks.navigate).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Technical details' }));
    expect(screen.getByRole('button', { name: 'Rebuild index' })).toBeTruthy();
    expect(screen.queryByText('AI evals')).toBeNull();
    expect(screen.getByRole('button', { name: 'Hide technical details' }).getAttribute('aria-expanded')).toBe('true');
  });
  it('reports a failed explicit deletion without claiming success', async () => {
    mocks.clear.mockRejectedValue(new Error('storage unavailable'));
    render(<AiIndexScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear saved feedback examples' }));
    expect(mocks.clear).not.toHaveBeenCalled();
    const actions = mocks.appAlert.mock.calls[0][2]!;
    actions.find((action: AlertButton) => action.text === 'Clear examples')!.onPress!();
    await waitFor(() =>
      expect(mocks.appAlert).toHaveBeenCalledWith(
        'Couldn’t clear examples',
        'Your saved examples are unchanged. Please try again.',
      ),
    );
  });
});
