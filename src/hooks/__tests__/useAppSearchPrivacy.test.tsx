import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const groups = [
    { groupId: 'secret', name: 'Secret trip', currency: 'USD', members: [], expenses: [], settlements: [], updatedAt: 3 },
    { groupId: 'public', name: 'Public trip', currency: 'USD', members: [], expenses: [], settlements: [], updatedAt: 2 },
    { groupId: 'hidden', name: 'Hidden trip', hidden: true, currency: 'USD', members: [], expenses: [], settlements: [], updatedAt: 1 },
  ];
  const settings = { hidePreviews: false };
  return {
    groups,
    user: { userId: 'me', lockedChats: {} },
    threads: [{ chatId: 'chat-1', type: 'direct', participants: [{ userId: 'other', displayName: 'Taylor' }], lastMessage: { type: 'text', content: 'Private sentence' } }],
    guard: {
      active: false,
      settings,
      isShielded: (_target: string, id?: string): boolean => id === 'secret',
    },
  };
});

vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock('@/context/GroupContext', () => ({ useGroups: () => ({ groups: state.groups }) }));
vi.mock('@/context/ChatContext', () => ({ useChat: () => ({ threads: state.threads }) }));
vi.mock('@/context/PrivacyGuardContext', () => ({ usePrivacyGuard: () => state.guard }));
vi.mock('@/constants/settingsRegistry', () => ({ SETTINGS_REGISTRY: [] }));
vi.mock('@/services/friendsService', () => ({ subscribeToFriends: () => () => {} }));
vi.mock('@/services/localCallStorage', () => ({ getCallHistory: async () => [] }));
vi.mock('@/services/localMessageStorage', () => ({ getChatMessagesPaginated: async () => ({ messages: [] }) }));

import { useAppSearch } from '../useAppSearch';

afterEach(() => {
  cleanup();
  state.guard.active = false;
  state.guard.settings.hidePreviews = false;
  state.guard.isShielded = (_target: string, id?: string) => id === 'secret';
});

it('removes shielded results immediately, before the debounced index rebuilds', async () => {
  const { result, rerender } = renderHook(() => useAppSearch());
  await waitFor(() => expect(result.current.search('Secret').some((item) => item.id === 'group-secret')).toBe(true));
  expect(result.current.search('Secret').some((item) => item.id === 'group-secret')).toBe(true);
  expect(result.current.search('Hidden').some((item) => item.id === 'group-hidden')).toBe(false);

  state.guard.active = true;
  rerender();
  expect(result.current.search('Secret').some((item) => item.id === 'group-secret')).toBe(false);
  expect(result.current.search('Public').some((item) => item.id === 'group-public')).toBe(true);
  expect(result.current.getSuggestions('all')).toContain('Public trip');
  expect(result.current.getSuggestions('all')).not.toContain('Secret trip');

  // Changing a selective scope while the shield is already active must
  // refresh suggestions and result visibility without waiting for indexing.
  state.guard.isShielded = (_target: string, id?: string) => id === 'public';
  rerender();
  expect(result.current.search('Secret').some((item) => item.id === 'group-secret')).toBe(true);
  expect(result.current.search('Public').some((item) => item.id === 'group-public')).toBe(false);
  expect(result.current.getSuggestions('all')).toContain('Secret trip');
  expect(result.current.getSuggestions('all')).not.toContain('Public trip');
});

it('removes cached chat previews as soon as hide previews becomes active', async () => {
  const { result, rerender } = renderHook(() => useAppSearch());
  await waitFor(() => expect(result.current.search('Private sentence').some((item) => item.id === 'chat-chat-1')).toBe(true));
  expect(result.current.search('Private sentence').some((item) => item.id === 'chat-chat-1')).toBe(true);

  state.guard.active = true;
  state.guard.settings.hidePreviews = true;
  rerender();
  expect(result.current.search('Private sentence').some((item) => item.id === 'chat-chat-1')).toBe(false);
});
