// Masking hooks for the privacy guard's disguise engine.
//
// usePrivacyMask returns helpers that pass values through untouched until the
// guard trips, then mask them per the user's style + scope settings:
//   maskGroupName(name, groupId)        — expense-group names
//   maskChatTitle(title, chatId, kind)  — conversation titles (person for DMs, group for group chats)
//   maskPersonName(name)                — people (friends target)
//   maskCallerName(name)                — names in the call log
//   maskPreview(text, chatId)           — chat-list last-message previews
//   maskGroupText(text, groupId, kind)  — any text inside an expense group; pass
//                                         the DisguiseKind so the convincing
//                                         dictionary style picks the right pool
//   maskGroupDate(ts, groupId, format)  — a date in a group
//   hidePhoto(kind, entityId)           — whether an avatar photo should drop to initials
//
// In the DURESS decoy world the user's chosen style is overridden with the
// convincing dictionary style and every disguise toggle is forced on — dots or
// blocks on screen would instantly betray the fake unlock. Group data is the
// exception: it is disguised at the source (useGroups), so the group masks
// pass it through unchanged there.

import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { decoyTimestamp, inScope, maskTextValue, type DisguiseKind } from '@/services/privacyGuardService';
import { useMemo } from 'react';

export const usePrivacyMask = () => {
  const { settings, isShielded, duress } = usePrivacyGuard();

  return useMemo(() => {
    const tripped = isShielded('expenses') || isShielded('chats') || isShielded('friends');
    const style = duress ? 'garble' : settings.textStyle;
    const hideNames = duress || settings.hideNames;
    const hidePreviews = duress || settings.hidePreviews;
    const hidePhotos = duress || settings.hidePhotos;

    // Group-domain masks pass through in duress: useGroups() already hands
    // screens the disguised copy (services/duressDecoy.ts), and masking it
    // again would give one person or group two different fake names.
    const maskGroupName = (name: string, groupId?: string): string =>
      !duress && isShielded('expenses') && hideNames && inScope(settings.groupScope, groupId)
        ? maskTextValue(name, style, 'group')
        : name;

    const maskChatTitle = (title: string, chatId?: string, kind: DisguiseKind = 'person'): string =>
      isShielded('chats', chatId) && hideNames
        ? maskTextValue(title, style, kind)
        : title;

    // In duress a person shown in a group is already a decoy name (the group
    // data is disguised at the source); people shown elsewhere — Friends,
    // Calls — must get the SAME fake, so expenses-shielded counts here too.
    // disguiseText is deterministic per real name, which keeps them equal.
    const maskPersonName = (name: string): string =>
      (isShielded('friends') || (duress && isShielded('expenses'))) && hideNames
        ? maskTextValue(name, style, 'person')
        : name;

    // Call log names (Calls tab, call details). Same fake as maskPersonName so
    // a person reads the same in calls, friends and groups.
    const maskCallerName = (name: string): string =>
      (isShielded('calls') || isShielded('friends') || (duress && isShielded('expenses'))) && hideNames
        ? maskTextValue(name, style, 'person')
        : name;

    const maskPreview = (text: string, chatId?: string): string => {
      if (!(isShielded('chats', chatId) && hidePreviews)) return text;
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
      !duress && isShielded('expenses', groupId) && hideNames
        ? maskTextValue(text, style, kind)
        : text;

    // A date inside an expense group. "Fake names" style shows a believable
    // date moved by a stable per-group offset (gibberish like "Oku 85" is not
    // a fake, it is a flag); dots/blocks redact it. In duress the decoy data
    // already carries shifted dates.
    const maskGroupDate = (
      timestamp: number,
      groupId: string | undefined,
      format: (date: Date) => string,
    ): string => {
      if (duress || !isShielded('expenses', groupId) || !hideNames) return format(new Date(timestamp));
      if (style === 'garble') return format(new Date(decoyTimestamp(timestamp, groupId ?? 'global')));
      return maskTextValue(format(new Date(timestamp)), style, 'raw');
    };

    const hidePhoto = (): boolean => tripped && hidePhotos;

    return { maskGroupName, maskChatTitle, maskPersonName, maskCallerName, maskPreview, maskGroupText, maskGroupDate, hidePhoto };
  }, [settings, isShielded, duress]);
};
