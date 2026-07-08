/**
 * Regression test for the hooks-after-early-return crash in AlbumBubble.
 *
 * AlbumBubble early-returns null when every album member is deleted/hidden.
 * Two useMemo hooks used to live BELOW that early return, so when messages
 * became visible again (sync lands, deletion state changes) the same mounted
 * component re-rendered with MORE hooks and React crashed with "Rendered
 * more hooks than during the previous render". This covers the recovery
 * path: empty first, messages become visible, bubble re-renders.
 */

import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { userId: 'u1' } }),
}));

const themeColors = new Proxy({}, { get: () => '#123456' });

vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: { colors: themeColors }, isDark: false }),
}));

vi.mock('@/components/Chat/ReactionsRow', () => ({
  ReactionsRow: () => null,
}));

vi.mock('@/utils/useResolvedMediaUri', () => ({
  useResolvedMediaUri: () => ({
    uri: 'file://photo.jpg',
    isDownloading: false,
    errored: false,
    handleLoadError: vi.fn(),
  }),
}));

vi.mock('@/utils/videoThumbnail', () => ({
  useCachedVideoThumbnail: () => undefined,
}));

vi.mock('@/services/messageRenderCache', () => ({
  buildStamp: () => 'stamp',
}));

vi.mock('@/utils/format', () => ({
  formatRelativeTime: () => 'now',
}));

vi.mock('@expo/vector-icons/Ionicons', () => ({
  default: () => null,
}));

vi.mock('react-native-paper', () => ({
  Text: ({ children }: any) => <span>{children}</span>,
}));

import { AlbumBubble } from '@/components/AlbumBubble';

const baseMessage = (overrides: Record<string, unknown>) => ({
  id: 'm1',
  messageId: 'm1',
  chatId: 'chat-1',
  senderId: 'u2',
  type: 'image',
  content: '',
  status: 'sent',
  timestamp: Date.now(),
  createdAt: Date.now(),
  deletedForEveryone: false,
  deletedFor: [],
  ...overrides,
});

describe('AlbumBubble empty → messages become visible', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders nothing when every album member is deleted', () => {
    const { container } = render(
      <AlbumBubble
        messages={[baseMessage({ deletedForEveryone: true }) as any]}
        senderName="Bob"
        isGroupChat
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('re-renders into the album without crashing when messages become visible', () => {
    const deleted = [baseMessage({ deletedForEveryone: true }) as any];
    const { container, rerender } = render(
      <AlbumBubble messages={deleted} senderName="Bob" isGroupChat showSenderInfo />,
    );
    expect(container.innerHTML).toBe('');

    // Sync lands / deletion state flips: the same mounted component now has
    // visible members. Before the fix (two useMemo hooks below the early
    // return) this exact re-render crashed with "Rendered more hooks than
    // during the previous render".
    const visible = [
      baseMessage({ id: 'm1', messageId: 'm1' }) as any,
      baseMessage({ id: 'm2', messageId: 'm2' }) as any,
    ];
    rerender(
      <AlbumBubble messages={visible} senderName="Bob" isGroupChat showSenderInfo />,
    );

    expect(container.innerHTML).not.toBe('');
    expect(screen.getByText('Bob')).toBeTruthy();
  });
});
