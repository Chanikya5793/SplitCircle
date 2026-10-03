import { act, cleanup, render, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  reduceMotion: false,
  focused: true,
  appState: 'active',
  wallpaper: null as null | { kind: 'solid'; light: string; dark: string },
  listeners: new Map<string, Set<(...args: any[]) => void>>(),
  tasks: [] as { run: () => void; cancel: ReturnType<typeof vi.fn> }[],
  loops: new Set<object>(),
  resolveMotion: (_value: boolean) => {},
}));
const emit = (event: string, value?: unknown) => {
  act(() => state.listeners.get(event)?.forEach((listener) => listener(value)));
};

vi.mock('@react-navigation/native', async () => {
  const { createContext } = await import('react');
  return { NavigationContext: createContext(undefined) };
});
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  const listen = (event: string, listener: (...args: any[]) => void) => {
    if (!state.listeners.has(event)) state.listeners.set(event, new Set());
    state.listeners.get(event)!.add(listener);
    return { remove: () => state.listeners.get(event)?.delete(listener) };
  };
  return {
    ...actual,
    AppState: {
      get currentState() { return state.appState; },
      addEventListener: listen,
    },
    InteractionManager: {
      runAfterInteractions: (run: () => void) => {
        const task = { run, cancel: vi.fn() };
        state.tasks.push(task);
        return task;
      },
    },
    AccessibilityInfo: {
      isReduceMotionEnabled: () => new Promise<boolean>((resolve) => { state.resolveMotion = resolve; }),
      isReduceTransparencyEnabled: async () => false,
      isScreenReaderEnabled: async () => false,
      addEventListener: listen,
    },
  };
});
vi.mock('react-native-reanimated', async () => {
  const { useState } = await import('react');
  const { View } = await import('react-native');
  return {
    default: { View },
    useSharedValue: (initial: number) => useState(() => {
      let value: unknown = initial;
      const shared = {
        get value() { return value; },
        set value(next: unknown) { value = next; state.loops.add(shared); },
      };
      return shared;
    })[0],
    useAnimatedStyle: () => ({}),
    cancelAnimation: (shared: object) => state.loops.delete(shared),
    withRepeat: () => ({ running: true }),
    withSequence: (...args: unknown[]) => args,
    withTiming: (value: number) => value,
    Easing: { ease: 'ease', quad: 'quad', inOut: (value: unknown) => value },
  };
});
vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: { accentId: 'ocean', reduceMotion: state.reduceMotion }, themeProgress: { value: 0 }, isDark: false }),
}));
vi.mock('@/context/PrivacyGuardContext', () => ({ usePrivacyGuard: () => ({ active: false, settings: {} }) }));
vi.mock('@/hooks/useWallpaper', () => ({ useWallpaper: () => state.wallpaper, useWallpaperChain: () => null }));

import { NavigationContext } from '@react-navigation/native';
import { LiquidBackground } from '../LiquidBackground';
import { useAccessibilitySettings } from '@/hooks/useAccessibilitySettings';

const navigation = {
  isFocused: () => state.focused,
  addListener: (event: string, callback: () => void) => {
    if (!state.listeners.has(event)) state.listeners.set(event, new Set());
    state.listeners.get(event)!.add(callback);
    return () => state.listeners.get(event)?.delete(callback);
  },
} as unknown as NonNullable<React.ContextType<typeof NavigationContext>>;
const background = () => <LiquidBackground><span>Content</span></LiquidBackground>;
const navigated = () => createElement(NavigationContext.Provider, { value: navigation }, background());
const settle = () => act(() => state.tasks.at(-1)?.run());

beforeEach(() => {
  state.reduceMotion = false;
  state.focused = true;
  state.appState = 'active';
  state.wallpaper = null;
  state.listeners.clear();
  state.tasks.length = 0;
  state.loops.clear();
});
afterEach(cleanup);

describe('LiquidBackground motion lifecycle', () => {
  it('waits for interactions and works outside navigation during startup', () => {
    const view = render(background());
    expect(state.loops.size).toBe(0);
    settle();
    expect(state.loops.size).toBe(9);
    view.unmount();
    expect(state.loops.size).toBe(0);
    expect([...state.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it('does not start with Reduce Motion enabled and cancels existing loops on a live change', () => {
    state.reduceMotion = true;
    const view = render(background());
    expect(state.tasks).toHaveLength(0);
    expect(state.loops.size).toBe(0);
    state.reduceMotion = false;
    view.rerender(background());
    settle();
    expect(state.loops.size).toBe(9);
    state.reduceMotion = true;
    view.rerender(background());
    expect(state.loops.size).toBe(0);
  });

  it.each(['inactive', 'background'])('stops while %s and waits before resuming', (status) => {
    render(background());
    settle();
    state.appState = status;
    emit('change', status);
    expect(state.loops.size).toBe(0);
    state.appState = 'active';
    emit('change', 'active');
    expect(state.loops.size).toBe(0);
    settle();
    expect(state.loops.size).toBe(9);
  });

  it('does not animate an unfocused screen, stops on blur, and ignores a cancelled interaction callback', () => {
    state.focused = false;
    render(navigated());
    expect(state.tasks).toHaveLength(0);
    state.focused = true;
    emit('focus');
    const cancelledTask = state.tasks.at(-1)!;
    state.focused = false;
    emit('blur');
    expect(cancelledTask.cancel).toHaveBeenCalled();
    state.focused = true;
    emit('focus');
    act(() => cancelledTask.run());
    expect(state.loops.size).toBe(0);
    settle();
    expect(state.loops.size).toBe(9);
    state.focused = false;
    emit('blur');
    expect(state.loops.size).toBe(0);
  });

  it('cancels loops when a solid wallpaper replaces the blobs', () => {
    const view = render(background());
    settle();
    expect(state.loops.size).toBe(9);
    state.wallpaper = { kind: 'solid', light: '#fff', dark: '#000' };
    view.rerender(background());
    expect(state.loops.size).toBe(0);
    state.wallpaper = null;
    view.rerender(background());
    expect(state.loops.size).toBe(9);
  });
});

describe('initial OS motion preference', () => {
  it('stays still until the initial OS response permits motion', async () => {
    const { result } = renderHook(useAccessibilitySettings);
    expect(result.current.reduceMotion).toBe(true);
    await act(async () => state.resolveMotion(false));
    expect(result.current.reduceMotion).toBe(false);
  });

  it('does not let a late initial response overwrite a live preference change', async () => {
    const { result } = renderHook(useAccessibilitySettings);
    emit('reduceMotionChanged', true);
    await act(async () => state.resolveMotion(false));
    expect(result.current.reduceMotion).toBe(true);
  });
});
