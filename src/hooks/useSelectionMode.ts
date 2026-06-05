import type { ChatMessage } from '@/models';
import { useCallback, useMemo, useState } from 'react';
import { mediumHaptic } from '@/utils/haptics';

export const useSelectionMode = (messages: ChatMessage[]) => {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const enterSelectionMode = useCallback((seed?: ChatMessage) => {
    setSelectionMode(true);
    if (seed) {
      const id = seed.messageId || seed.id;
      setSelectedIds(new Set([id]));
    } else {
      setSelectedIds(new Set());
    }
    mediumHaptic();
  }, []);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelected = useCallback((message: ChatMessage) => {
    const id = message.messageId || message.id;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedMessages = useMemo(
    () => messages.filter((m) => selectedIds.has(m.messageId || m.id)),
    [messages, selectedIds],
  );

  const enterSelectionModeMulti = useCallback((ids: string[]) => {
    setSelectionMode(true);
    setSelectedIds(new Set(ids));
    mediumHaptic();
  }, []);

  return {
    selectionMode,
    selectedIds,
    selectedMessages,
    enterSelectionMode,
    enterSelectionModeMulti,
    exitSelectionMode,
    toggleSelected,
  };
};
