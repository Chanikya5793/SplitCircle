/**
 * Verifies the stale-deep-link fallback for group routes: a notification for
 * a deleted group lands on GroupLoadingFallback, which shows a spinner while
 * Firestore might still sync, then times out (~10s) into "Group not found"
 * with a Go back button that escapes correctly (goBack with history,
 * otherwise navigate to the Expenses tab).
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-constants', () => ({
  default: { expoConfig: { name: 'SplitCircle', version: '1.0.0' } },
}));

vi.mock('@/components/LiquidBackground', () => ({
  LiquidBackground: ({ children }: any) => <div data-testid="liquid-bg">{children}</div>,
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
}));

vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({
    theme: {
      colors: { primary: '#5A67F2', muted: '#888' },
    },
    isDark: false,
  }),
}));

vi.mock('react-native-paper', () => ({
  ActivityIndicator: (props: any) => <div role="progressbar" data-testid="spinner" />,
  Text: ({ children }: any) => <span>{children}</span>,
  MD3LightTheme: { colors: {}, fonts: {} },
  MD3DarkTheme: { colors: {}, fonts: {} },
}));

import { GroupLoadingFallback } from '@/navigation/GroupLoadingFallback';
import { ROUTES } from '@/constants';

const makeNavigation = (canGoBack: boolean) => ({
  canGoBack: vi.fn(() => canGoBack),
  goBack: vi.fn(),
  navigate: vi.fn(),
});

describe('GroupLoadingFallback (stale group deep link)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows a spinner first (deep link waiting for Firestore sync)', () => {
    const navigation = makeNavigation(true);
    render(<GroupLoadingFallback navigation={navigation} />);

    expect(screen.getByTestId('spinner')).toBeTruthy();
    expect(screen.queryByText('Group not found')).toBeNull();
  });

  it('times out into "Group not found" after 10s', () => {
    const navigation = makeNavigation(true);
    render(<GroupLoadingFallback navigation={navigation} />);

    act(() => {
      vi.advanceTimersByTime(9999);
    });
    expect(screen.queryByText('Group not found')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText('Group not found')).toBeTruthy();
    expect(
      screen.getByText("This group may have been deleted or isn't available on this device."),
    ).toBeTruthy();
    expect(screen.getByText('Go back')).toBeTruthy();
  });

  it('Go back uses goBack when there is navigation history', () => {
    const navigation = makeNavigation(true);
    render(<GroupLoadingFallback navigation={navigation} />);

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    fireEvent.click(screen.getByText('Go back'));

    expect(navigation.goBack).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('Go back falls back to the Expenses tab without history (cold start)', () => {
    const navigation = makeNavigation(false);
    render(<GroupLoadingFallback navigation={navigation} />);

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    fireEvent.click(screen.getByText('Go back'));

    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(navigation.navigate).toHaveBeenCalledWith(ROUTES.APP.ROOT, {
      screen: ROUTES.APP.GROUPS_TAB,
    });
  });

  it('does not show the timeout state if unmounted before 10s (group synced in time)', () => {
    const navigation = makeNavigation(true);
    const { unmount } = render(<GroupLoadingFallback navigation={navigation} />);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    // Timer was cleaned up — nothing thrown, no state update after unmount.
    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });
});
