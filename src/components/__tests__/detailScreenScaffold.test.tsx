import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ header: 100, insets: { top: 0, bottom: 34, left: 0, right: 0 }, scroll: {} as any, refresh: {} as any, fade: {} as any }));
vi.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => state.header }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => state.insets }));
vi.mock('@/context/ThemeContext', () => ({ useTheme: () => ({ theme: { spacing: { lg: 24, xl: 32 } } }) }));
vi.mock('../ui/TopEdgeFade', () => ({ TopEdgeFade: (props: any) => { state.fade = props; return props.children; } }));
vi.mock('react-native', () => ({
  ScrollView: React.forwardRef((props: any, ref: any) => { state.scroll = props; return <div ref={ref}>{props.refreshControl}{props.children}</div>; }),
  RefreshControl: (props: any) => { state.refresh = props; return <button onClick={props.onRefresh}>Refresh</button>; },
}));
import { RefreshControl } from 'react-native';
import { DetailScreenScaffold } from '../ui/DetailScreenScaffold';
afterEach(() => {
  cleanup();
  state.header = 100;
  state.insets = { top: 0, bottom: 34, left: 0, right: 0 };
});
describe('detail screen geometry ownership', () => {
  it('updates clearance with native header changes and protects against duplicate inset configuration', () => {
    const view = render(<DetailScreenScaffold contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingTop: 1, gap: 8 }}><span>Content</span></DetailScreenScaffold>);
    expect(state.scroll.contentInsetAdjustmentBehavior).toBe('never');
    expect(state.scroll.contentContainerStyle.at(-1)).toEqual({
      paddingTop: 124,
      paddingBottom: 66,
      paddingLeft: 16,
      paddingRight: 16,
    });
    state.header = 120;
    view.rerender(<DetailScreenScaffold bottomSpacing={180}><span>Content</span></DetailScreenScaffold>);
    expect(state.fade.height).toBe(120);
    expect(state.scroll.contentContainerStyle.at(-1)).toEqual({
      paddingTop: 144,
      paddingBottom: 214,
      paddingLeft: 16,
      paddingRight: 16,
    });
    expect(state.scroll.scrollIndicatorInsets).toEqual({ top: 120, bottom: 34 });
  });
  it('adds a readable gutter inside horizontal safe areas when a screen opts in', () => {
    state.insets = { top: 0, bottom: 34, left: 47, right: 21 };
    render(<DetailScreenScaffold horizontalInset={16}><span>Landscape content</span></DetailScreenScaffold>);
    expect(state.scroll.contentContainerStyle.at(-1)).toEqual({
      paddingTop: 124,
      paddingBottom: 66,
      paddingLeft: 63,
      paddingRight: 37,
    });
    expect(state.scroll.scrollIndicatorInsets).toEqual({ top: 100, bottom: 34 });
  });
  it('keeps refresh callbacks and keyboard behavior while positioning the refresh control below chrome', () => {
    const refresh = vi.fn();
    render(<DetailScreenScaffold keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}><span>Editor</span></DetailScreenScaffold>);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(state.refresh.progressViewOffset).toBe(state.header + 24);
    expect(state.scroll.keyboardShouldPersistTaps).toBe('handled');
    expect(state.scroll.automaticallyAdjustKeyboardInsets).toBe(true);
  });
});
