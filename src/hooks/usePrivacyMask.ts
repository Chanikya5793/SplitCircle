// Masking hooks for the privacy guard's disguise engine.
//
// usePrivacyMask returns helpers that pass values through untouched until the
// guard trips, then mask them per the user's style + scope settings:
//   maskGroupName(name, groupId)        — expense-group names
//   maskChatTitle(title, chatId, kind)  — conversation titles (person for DMs, group for group chats)
//   maskPersonName(name)                — people (friends target)
//   maskPreview(text, chatId)           — chat-list last-message previews
//   maskGroupText(text, groupId, kind)  — any text inside an expense group; pass
//                                         the DisguiseKind so the convincing
//                                         dictionary style picks the right pool
//   hidePhoto(kind, entityId)           — whether an avatar photo should drop to initials
//
// In the DURESS decoy world the user's chosen style is overridden with the
// convincing dictionary style and every disguise toggle is forced on — dots or
// blocks on screen would instantly betray the fake unlock.

import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { inScope, maskTextValue, type DisguiseKind } from '@/services/privacyGuardService';
import { useMemo } from 'react';

export const usePrivacyMask = () => {
  const { settings, isShielded, duress } = usePrivacyGuard();

  return useMemo(() => {
    const tripped = isShielded('expenses') || isShielded('chats') || isShielded('friends');
    const style = duress ? 'garble' : settings.textStyle;
    const hideNames = duress || settings.hideNames;
    const hidePreviews = duress || settings.hidePreviews;
    const hidePhotos = duress || settings.hidePhotos;

    const maskGroupName = (name: string, groupId?: string): string =>
      isShielded('expenses') && hideNames && inScope(settings.groupScope, groupId)
        ? maskTextValue(name, style, 'group')
        : name;

    const maskChatTitle = (title: string, chatId?: string, kind: DisguiseKind = 'person'): string =>
      isShielded('chats') && hideNames && inScope(settings.chatScope, chatId)
        ? maskTextValue(title, style, kind)
        : title;

    const maskPersonName = (name: string): string =>
      isShielded('friends') && hideNames ? maskTextValue(name, style, 'person') : name;

    const maskPreview = (text: string, chatId?: string): string => {
      if (!(isShielded('chats') && hidePreviews && inScope(settings.chatScope, chatId))) return text;
      // Drop any leading type glyph (📷/📞/📄/🚫 …) before masking so the
      // preview reveals neither content nor message CATEGORY.
      const stripped = text.replace(/^[^\p{L}\p{N}]+/u, '');
      return maskTextValue(stripped || text, style, 'preview');
    };

    // Text inside an expense group — expense titles, payer/member names,
    // categories, notes, dates. Gated on the expenses shield + hideNames +
    // the group's scope. Pass the kind so the dictionary style stays convincing
    // ('raw' garbles — right for dates and codes, wrong for names).
    const maskGroupText = (text: string, groupId?: string, kind: DisguiseKind = 'raw'): string =>
      isShielded('expenses', groupId) && hideNames
        ? maskTextValue(text, style, kind)
        : text;

    const hidePhoto = (): boolean => tripped && hidePhotos;

    return { maskGroupName, maskChatTitle, maskPersonName, maskPreview, maskGroupText, hidePhoto };
  }, [settings, isShielded, duress]);
};
