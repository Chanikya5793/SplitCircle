/**
 * Verifies the stale-deep-link fallback in ExpenseDetailsScreen:
 * - group synced but expense missing (deleted expense) → immediate
 *   "Expense not found" with a working Go back
 * - group not synced yet → spinner, then timeout (~10s) into
 *   "Expense not found" with a working Go back
 * - Go back: goBack with history, otherwise navigate to the Expenses tab
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navMock = {
  canGoBack: vi.fn(() => true),
  goBack: vi.fn(),
  navigate: vi.fn(),
  setOptions: vi.fn(),
};

vi.mock('@react-navigation/native', () => ({
  useNavigation: () => navMock,
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { name: 'SplitCircle', version: '1.0.0' } },
}));

vi.mock('expo-linking', () => ({
  openURL: vi.fn(),
  createURL: vi.fn(),
}));

vi.mock('@/components/LiquidBackground', () => ({
  LiquidBackground: ({ children }: any) => <div data-testid="liquid-bg">{children}</div>,
}));

vi.mock('@/components/GlassView', () => ({
  GlassView: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('@/components/PrimaryButton', () => ({
  PrimaryButton: ({ children }: any) => <button type="button">{children}</button>,
}));

vi.mock('@/components/ui', () => ({
  EmptyState: ({ title, hint, actionLabel, onAction }: any) => (
    <div>
      <div>{title}</div>
      {hint ? <div>{hint}</div> : null}
      {actionLabel && onAction ? (
        <button type="button" onClick={() => onAction()}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  ),
  GuardedScreen: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({
    theme: {
      colors: {
        primary: '#5A67F2',
        muted: '#888',
        onSurface: '#111',
        surface: '#fff',
        success: '#2e7d32',
        error: '#c62828',
        primaryContainer: '#e0e2ff',
        appBackground: '#fafafa',
        outline: '#ccc',
      },
      spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
      radius: { sm: 6, md: 10, lg: 16, pill: 999 },
      typography: {
        subtitle: { fontSize: 16, fontWeight: '600' },
        caption: { fontSize: 12, lineHeight: 16 },
      },
    },
    isDark: false,
  }),
}));

vi.mock('react-native-paper', () => {
  const Stub = ({ children }: any) => <div>{children}</div>;
  return {
    ActivityIndicator: () => <div role="progressbar" data-testid="spinner" />,
    Text: ({ children }: any) => <span>{children}</span>,
    Button: Stub,
    Chip: Stub,
    Dialog: Object.assign(Stub, { Title: Stub, Content: Stub, Actions: Stub }),
    Divider: () => <hr />,
    Icon: () => <span />,
    IconButton: () => <button type="button" />,
    Portal: Stub,
    TextInput: Stub,
    MD3LightTheme: { colors: {}, fonts: {} },
    MD3DarkTheme: { colors: {}, fonts: {} },
  };
});

// Mock AuthContext so the real one (which imports @/firebase and validates
// EXPO_PUBLIC_FIREBASE_* env vars at module load) never loads in the test env.
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { userId: 'u1' } }),
}));

// Mock the money formatter so its privacy-guard / expo-modules-core import
// chain (SecureStore et al.) never loads in the jsdom test env.
vi.mock('@/hooks/useMoneyDisplay', () => ({
  useMoneyDisplay: () => (value: number, currency?: string) => `${currency ?? '$'}${value}`,
}));

const groupsState: { groups: any[] } = { groups: [] };

vi.mock('@/context/GroupContext', () => ({
  useGroups: () => ({
    groups: groupsState.groups,
    deleteExpense: vi.fn(),
    updateExpense: vi.fn(),
  }),
}));

import { ExpenseDetailsScreen } from '@/screens/expenses/ExpenseDetailsScreen';
import { ROUTES } from '@/constants';

const GROUP_ID = 'group-1';
const EXPENSE_ID = 'expense-1';

const syncedGroupWithoutExpense = {
  groupId: GROUP_ID,
  name: 'Trip to Rome',
  currency: 'USD',
  members: [],
  archivedMembers: [],
  expenses: [],
};

const renderScreen = () =>
  render(
    <ExpenseDetailsScreen
      route={{ params: { groupId: GROUP_ID, expenseId: EXPENSE_ID } }}
      navigation={navMock as any}
    />,
  );

describe('ExpenseDetailsScreen stale deep-link fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    navMock.canGoBack.mockReturnValue(true);
    navMock.goBack.mockClear();
    navMock.navigate.mockClear();
    groupsState.groups = [];
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows "Expense not found" immediately when the group is synced but the expense was deleted', () => {
    groupsState.groups = [syncedGroupWithoutExpense];
    renderScreen();

    // No waiting: the group is here, the expense is definitively gone.
    expect(screen.getByText('Expense not found')).toBeTruthy();
    expect(screen.getByText('This expense may have been deleted.')).toBeTruthy();
    expect(screen.queryByTestId('spinner')).toBeNull();

    fireEvent.click(screen.getByText('Go back'));
    expect(navMock.goBack).toHaveBeenCalledTimes(1);
  });

  it('waits with a spinner when the group is not synced, then times out into "Expense not found"', () => {
    groupsState.groups = [];
    renderScreen();

    expect(screen.getByTestId('spinner')).toBeTruthy();
    expect(screen.queryByText('Expense not found')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(screen.getByText('Expense not found')).toBeTruthy();
    expect(
      screen.getByText("This expense may have been deleted or isn't available on this device."),
    ).toBeTruthy();
  });

  it('timeout Go back uses goBack when there is history', () => {
    groupsState.groups = [];
    renderScreen();

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    fireEvent.click(screen.getByText('Go back'));

    expect(navMock.goBack).toHaveBeenCalledTimes(1);
    expect(navMock.navigate).not.toHaveBeenCalled();
  });

  it('timeout Go back falls back to the Expenses tab without history (cold start)', () => {
    groupsState.groups = [];
    navMock.canGoBack.mockReturnValue(false);
    renderScreen();

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    fireEvent.click(screen.getByText('Go back'));

    expect(navMock.goBack).not.toHaveBeenCalled();
    expect(navMock.navigate).toHaveBeenCalledWith(ROUTES.APP.ROOT, {
      screen: ROUTES.APP.GROUPS_TAB,
    });
  });

  it('recovers when the group syncs in before the timeout (valid deep link)', () => {
    groupsState.groups = [];
    const { rerender } = renderScreen();
    expect(screen.getByTestId('spinner')).toBeTruthy();

    // Firestore sync lands: group + expense now exist.
    groupsState.groups = [
      {
        ...syncedGroupWithoutExpense,
        members: [{ userId: 'u1', displayName: 'Alice' }],
        expenses: [
          {
            expenseId: EXPENSE_ID,
            title: 'Dinner',
            amount: 42,
            paidBy: 'u1',
            category: 'Food',
            date: new Date().toISOString(),
            participants: [{ userId: 'u1', share: 42 }],
            splitType: 'equal',
          },
        ],
      },
    ];
    rerender(
      <ExpenseDetailsScreen
        route={{ params: { groupId: GROUP_ID, expenseId: EXPENSE_ID } }}
        navigation={navMock as any}
      />,
    );

    // The fallback is gone — the real screen rendered (expense title visible).
    expect(screen.queryByTestId('spinner')).toBeNull();
    expect(screen.queryByText('Expense not found')).toBeNull();
    expect(screen.getAllByText('Dinner').length).toBeGreaterThan(0);
  });
});
