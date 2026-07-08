/**
 * Regression test for the hooks-after-early-return crash in GroupInfoScreen.
 *
 * The screen early-returns a "Group not found" fallback while the group is
 * still syncing in. Two useState hooks used to live BELOW that early return,
 * so when the group synced in, the same mounted component re-rendered with
 * MORE hooks and React crashed with "Rendered more hooks than during the
 * previous render". This covers the recovery path: fallback first, group
 * syncs in, screen re-renders with the real content.
 */

import { cleanup, render, screen } from '@testing-library/react';
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
  useRoute: () => ({ params: { groupId: 'group-1' } }),
}));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: any) => <div>{children}</div>,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/LiquidBackground', () => ({
  LiquidBackground: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('@/components/GlassView', () => ({
  GlassView: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('@/components/ui', () => ({
  GroupAvatar: () => <div data-testid="group-avatar" />,
  GroupPhotoUploader: () => <div data-testid="group-photo" />,
  GuardedScreen: ({ children }: any) => <div>{children}</div>,
  CurrencyConvertSheet: () => null,
  WallpaperPickerSheet: () => null,
}));

vi.mock('@/services/wallpaperService', () => ({
  getWallpaperSync: () => null,
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { name: 'SplitCircle', version: '1.0.0' } },
}));

vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(),
}));

vi.mock('@/utils/haptics', () => ({
  errorHaptic: vi.fn(),
  lightHaptic: vi.fn(),
  selectionHaptic: vi.fn(),
  successHaptic: vi.fn(),
}));

vi.mock('react-native-gesture-handler', () => ({
  RectButton: ({ children }: any) => <div>{children}</div>,
  Swipeable: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('@expo/vector-icons', () => ({
  MaterialCommunityIcons: () => null,
}));

// Any color key resolves to a hex string so styling never crashes the render.
const themeColors = new Proxy({}, { get: () => '#123456' });

vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: { colors: themeColors }, isDark: false }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { userId: 'u1' } }),
}));

vi.mock('@/context/ChatContext', () => ({
  useChat: () => ({ ensureGroupThread: vi.fn() }),
}));

const groupsState: { groups: any[] } = { groups: [] };

vi.mock('@/context/GroupContext', () => ({
  useGroups: () => ({
    groups: groupsState.groups,
    updateGroup: vi.fn(),
    updateMemberRole: vi.fn(),
    removeMember: vi.fn(),
    leaveGroup: vi.fn(),
    deleteGroup: vi.fn(),
  }),
}));

vi.mock('react-native-paper', () => {
  const ListItem = ({ title, description }: any) => (
    <div>
      {typeof title === 'string' ? <span>{title}</span> : null}
      {typeof description === 'string' ? <span>{description}</span> : null}
    </div>
  );
  return {
    Text: ({ children }: any) => <span>{children}</span>,
    Button: ({ children, onPress }: any) => (
      <button type="button" onClick={onPress}>
        {children}
      </button>
    ),
    Divider: () => <hr />,
    IconButton: () => <button type="button" />,
    List: { Item: ListItem, Icon: () => <span /> },
    Avatar: { Text: ({ label }: any) => <span>{label}</span> },
    TextInput: () => <input />,
    MD3LightTheme: { colors: {}, fonts: {} },
    MD3DarkTheme: { colors: {}, fonts: {} },
  };
});

import { GroupInfoScreen } from '@/screens/groups/GroupInfoScreen';

const syncedGroup = {
  groupId: 'group-1',
  name: 'Trip to Rome',
  description: 'Girls trip',
  currency: 'USD',
  inviteCode: 'ABC123',
  createdBy: 'u1',
  createdAt: new Date('2026-01-01').toISOString(),
  members: [
    { userId: 'u1', displayName: 'Alice', role: 'owner' },
    { userId: 'u2', displayName: 'Bob', role: 'member' },
  ],
  archivedMembers: [],
  expenses: [],
};

describe('GroupInfoScreen fallback → group syncs in', () => {
  beforeEach(() => {
    groupsState.groups = [];
  });

  afterEach(() => {
    cleanup();
  });

  it('shows "Group not found" while the group has not synced yet', () => {
    render(<GroupInfoScreen />);
    expect(screen.getByText('Group not found')).toBeTruthy();
  });

  it('re-renders into the real screen without crashing when the group syncs in', () => {
    const { rerender } = render(<GroupInfoScreen />);
    expect(screen.getByText('Group not found')).toBeTruthy();

    // Firestore sync lands: the same mounted component re-renders with the
    // group present. Before the fix (two useState hooks below the early
    // return) this exact re-render crashed with "Rendered more hooks than
    // during the previous render".
    groupsState.groups = [syncedGroup];
    rerender(<GroupInfoScreen />);

    expect(screen.queryByText('Group not found')).toBeNull();
    expect(screen.getAllByText('Trip to Rome').length).toBeGreaterThan(0);
    expect(screen.getByText('Alice (you)')).toBeTruthy();
  });
});
