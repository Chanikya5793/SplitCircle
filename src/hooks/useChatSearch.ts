import type { ChatMessage } from '@/models';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FlatList } from 'react-native';

interface UseChatSearchOptions {
  messages: ChatMessage[];
  userId?: string;
  messageIdToRowIndex: Map<string, number>;
  listRef: React.RefObject<FlatList<any> | null>;
}

export const useChatSearch = ({ messages, userId, messageIdToRowIndex, listRef }: UseChatSearchOptions) => {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as string[];
    return messages
      .filter((m) => m.content && !m.deletedForEveryone && !m.deletedFor?.includes(userId ?? ''))
      .filter((m) => m.content.toLowerCase().includes(q))
      .map((m) => m.messageId || m.id);
  }, [messages, searchQuery, userId]);

  useEffect(() => {
    setSearchIndex(0);
  }, [searchQuery]);

  const jumpToSearchMatch = useCallback((index: number) => {
    if (searchMatches.length === 0) return;
    const safe = ((index % searchMatches.length) + searchMatches.length) % searchMatches.length;
    setSearchIndex(safe);
    const id = searchMatches[safe];
    const rowIdx = messageIdToRowIndex.get(id);
    if (rowIdx === undefined) return;
    listRef.current?.scrollToIndex({ index: rowIdx, animated: true, viewPosition: 0.5 });
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedMessageId(id);
    highlightTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 1400);
  }, [messageIdToRowIndex, searchMatches, listRef]);

  useEffect(() => {
    if (searchMatches.length > 0 && searchOpen) {
      jumpToSearchMatch(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchMatches.length, searchOpen]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  return {
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    searchIndex,
    searchMatches,
    jumpToSearchMatch,
    highlightedMessageId,
    setHighlightedMessageId,
    highlightTimerRef,
  };
};
