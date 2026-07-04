// Masking hooks for the privacy guard's disguise engine.
//
// usePrivacyMask returns helpers that pass values through untouched until the
// guard trips, then mask them per the user's style + scope settings:
//   maskGroupName(name, groupId)  — expense-group names
//   maskChatTitle(title, chatId)  — conversation titles
//   maskPersonName(name)          — people (friends target)
//   maskPreview(text, chatId)     — chat-list last-message previews
//   hidePhoto(kind, entityId)     — whether an avatar photo should drop to initials

import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { inScope, maskTextValue } from '@/services/privacyGuardService';
import { useMemo } from 'react';

export const usePrivacyMask = () => {
  const { settings, isShielded } = usePrivacyGuard();

  return useMemo(() => {
    const tripped = isShielded('expenses') || isShielded('chats') || isShielded('friends');
    const style = settings.textStyle;

    const maskGroupName = (name: string, groupId?: string): string =>
      isShielded('expenses') && settings.hideNames && inScope(settings.groupScope, groupId)
        ? maskTextValue(name, style)
        : name;

    const maskChatTitle = (title: string, chatId?: string): string =>
      isShielded('chats') && settings.hideNames && inScope(settings.chatScope, chatId)
        ? maskTextValue(title, style)
        : title;

    const maskPersonName = (name: string): string =>
      isShielded('friends') && settings.hideNames ? maskTextValue(name, style) : name;

    const maskPreview = (text: string, chatId?: string): string =>
      isShielded('chats') && settings.hidePreviews && inScope(settings.chatScope, chatId)
        ? maskTextValue(text, style)
        : text;

    // Text inside an expense group — expense titles, payer/member names.
    // Gated on the expenses shield + hideNames + the group's scope.
    const maskGroupText = (text: string, groupId?: string): string =>
      isShielded('expenses', groupId) && settings.hideNames
        ? maskTextValue(text, style)
        : text;

    const hidePhoto = (): boolean => tripped && settings.hidePhotos;

    return { maskGroupName, maskChatTitle, maskPersonName, maskPreview, maskGroupText, hidePhoto };
  }, [settings, isShielded]);
};
