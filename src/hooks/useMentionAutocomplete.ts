import type { ChatParticipant } from '@/models';
import { useCallback, useRef, useState } from 'react';

interface UseMentionAutocompleteOptions {
  participants: ChatParticipant[];
  inputRef: React.RefObject<any>;
}

export const useMentionAutocomplete = ({ participants, inputRef }: UseMentionAutocompleteOptions) => {
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAnchor, setMentionAnchor] = useState<{ start: number; end: number } | null>(null);
  const [pendingMentionUserIds, setPendingMentionUserIds] = useState<string[]>([]);
  const composerSelectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  const handleComposerSelectionChange = useCallback((event: { nativeEvent: { selection: { start: number; end: number } } }) => {
    composerSelectionRef.current = event.nativeEvent.selection;
  }, []);

  const detectMention = useCallback((text: string) => {
    const caret = composerSelectionRef.current.start ?? text.length;
    const upToCaret = text.slice(0, caret);
    const atIdx = upToCaret.lastIndexOf('@');
    if (atIdx === -1) {
      setMentionQuery(null);
      setMentionAnchor(null);
      return;
    }
    const before = atIdx === 0 ? '' : upToCaret[atIdx - 1];
    const isWordBoundary = atIdx === 0 || /\s/.test(before);
    if (!isWordBoundary) {
      setMentionQuery(null);
      setMentionAnchor(null);
      return;
    }
    const candidate = upToCaret.slice(atIdx + 1);
    if (/[\s\n]/.test(candidate)) {
      setMentionQuery(null);
      setMentionAnchor(null);
      return;
    }
    setMentionQuery(candidate);
    setMentionAnchor({ start: atIdx, end: caret });
  }, []);

  const handleMentionSelect = useCallback((participant: ChatParticipant, currentText: string, setText: (t: string) => void) => {
    if (!mentionAnchor) return;
    const handle = participant.displayName.replace(/\s+/g, '');
    const before = currentText.slice(0, mentionAnchor.start);
    const after = currentText.slice(mentionAnchor.end);
    const insertion = `@${handle} `;
    const next = `${before}${insertion}${after}`;
    setText(next);
    setMentionAnchor(null);
    setMentionQuery(null);
    setPendingMentionUserIds((prev) => Array.from(new Set([...prev, participant.userId])));
    setTimeout(() => {
      const newCaret = (before + insertion).length;
      inputRef.current?.setNativeProps?.({
        selection: { start: newCaret, end: newCaret },
      });
    }, 0);
  }, [mentionAnchor, inputRef]);

  const resetMention = useCallback(() => {
    setMentionQuery(null);
    setMentionAnchor(null);
  }, []);

  return {
    mentionQuery,
    mentionAnchor,
    pendingMentionUserIds,
    setPendingMentionUserIds,
    handleComposerSelectionChange,
    detectMention,
    handleMentionSelect,
    resetMention,
  };
};
