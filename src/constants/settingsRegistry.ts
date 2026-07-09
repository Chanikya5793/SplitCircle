/**
 * settingsRegistry — a single declarative source of truth for every individual
 * setting in the app. It powers two things:
 *   1) per-item search (see hooks/useAppSearch) so users can search a specific
 *      toggle (e.g. "auto-lock", "app lock", "notification sounds") and deep-link
 *      straight to the screen that hosts it, and
 *   2) highlight-on-arrival: each entry carries an `id` that the target screen
 *      uses to scroll the row into view and briefly pulse it.
 *
 * Keep this list in sync with the actual rows rendered by SettingsScreen /
 * NotificationSettingsScreen. Entries are intentionally UI-metadata only — no
 * state, no side effects — so it stays trivially testable and importable from
 * anywhere without pulling in React or native modules.
 */

import { ROUTES } from '@/constants/routes';

export interface SettingRegistryEntry {
  /** Stable id — also the value passed as the `highlight` deep-link param. */
  id: string;
  /** Row title as shown on the hosting screen. */
  title: string;
  /** Short supporting copy (used as the search-result subtitle). */
  subtitle?: string;
  /** Extra search terms beyond the title/subtitle. */
  keywords: string[];
  /** MaterialCommunityIcons glyph (matches ListRow / search icons). */
  icon: string;
  /** Human-readable grouping (mirrors the on-screen section header). */
  section: string;
  /** Destination route that renders this setting. */
  route: string;
}

/** Stable ids shared by the registry and the screens that render each row. */
export const SETTING_IDS = {
  appearance: 'appearance',
  wallpaperApp: 'wallpaper-app',
  wallpaperChat: 'wallpaper-chat',
  aiReceipts: 'ai-receipts',
  receiptStrict: 'receipt-strict',
  onDeviceAi: 'ondevice-ai',
  appLock: 'app-lock',
  autoLock: 'auto-lock',
  confirmSettlements: 'confirm-settlements',
  notifications: 'notifications',
  offlineSync: 'offline-sync',
  notifMaster: 'notif-master',
  notifMessages: 'notif-messages',
  notifExpenses: 'notif-expenses',
  notifSettlements: 'notif-settlements',
  notifGroup: 'notif-group',
  notifCalls: 'notif-calls',
  notifSounds: 'notif-sounds',
  notifVibration: 'notif-vibration',
} as const;

export const SETTINGS_REGISTRY: SettingRegistryEntry[] = [
  // Appearance ---------------------------------------------------------------
  {
    id: SETTING_IDS.appearance,
    title: 'Theme & appearance',
    subtitle: 'Light, dark, and accent color',
    keywords: ['theme', 'dark mode', 'light mode', 'appearance', 'accent', 'color', 'display', 'system'],
    icon: 'theme-light-dark',
    section: 'Appearance',
    route: ROUTES.APP.SETTINGS,
  },
  {
    id: SETTING_IDS.wallpaperApp,
    title: 'App background',
    subtitle: 'Wallpaper behind the app',
    keywords: ['wallpaper', 'background', 'app', 'image', 'liquid', 'photo'],
    icon: 'image-outline',
    section: 'Appearance',
    route: ROUTES.APP.SETTINGS,
  },
  {
    id: SETTING_IDS.wallpaperChat,
    title: 'Chat wallpaper',
    subtitle: 'Default wallpaper for chats & groups',
    keywords: ['wallpaper', 'chat', 'background', 'conversation', 'photo'],
    icon: 'forum-outline',
    section: 'Appearance',
    route: ROUTES.APP.SETTINGS,
  },

  // Receipts & AI ------------------------------------------------------------
  {
    id: SETTING_IDS.aiReceipts,
    title: 'AI receipt parsing',
    subtitle: 'Cloud AI sharpens OCR accuracy',
    keywords: ['ai', 'receipt', 'ocr', 'scan', 'parse', 'cloud'],
    icon: 'creation',
    section: 'Receipts & AI',
    route: ROUTES.APP.SETTINGS,
  },
  {
    id: SETTING_IDS.receiptStrict,
    title: 'Strict receipt review',
    subtitle: 'Review low-confidence rows before saving',
    keywords: ['receipt', 'review', 'strict', 'confidence', 'scan'],
    icon: 'shield-check-outline',
    section: 'Receipts & AI',
    route: ROUTES.APP.SETTINGS,
  },
  {
    id: SETTING_IDS.onDeviceAi,
    title: 'On-device AI',
    subtitle: "What's indexed on this device",
    keywords: ['ai', 'on-device', 'index', 'apple intelligence', 'assistant', 'privacy'],
    icon: 'chip',
    section: 'Receipts & AI',
    route: ROUTES.APP.AI_INDEX,
  },

  // Security -----------------------------------------------------------------
  {
    id: SETTING_IDS.appLock,
    title: 'App Lock',
    subtitle: 'Require Face ID / passcode to open',
    keywords: ['app lock', 'face id', 'touch id', 'biometric', 'passcode', 'security', 'lock'],
    icon: 'lock-outline',
    section: 'Security',
    route: ROUTES.APP.SETTINGS,
  },
  {
    id: SETTING_IDS.autoLock,
    title: 'Auto-lock',
    subtitle: 'Lock after a period of inactivity',
    keywords: ['auto-lock', 'auto lock', 'timeout', 'inactivity', 'lock'],
    icon: 'timer-outline',
    section: 'Security',
    route: ROUTES.APP.SETTINGS,
  },
  {
    id: SETTING_IDS.confirmSettlements,
    title: 'Confirm settlements',
    subtitle: 'Require Face ID before recording a settlement',
    keywords: ['settlement', 'confirm', 'face id', 'biometric', 'security', 'payment'],
    icon: 'shield-check-outline',
    section: 'Security',
    route: ROUTES.APP.SETTINGS,
  },

  // General ------------------------------------------------------------------
  {
    id: SETTING_IDS.notifications,
    title: 'Notifications',
    subtitle: 'Messages, expenses, sounds & more',
    keywords: ['notifications', 'push', 'alerts', 'sounds'],
    icon: 'bell-outline',
    section: 'General',
    route: ROUTES.APP.NOTIFICATION_SETTINGS,
  },
  {
    id: SETTING_IDS.offlineSync,
    title: 'Offline sync',
    subtitle: 'Connectivity and pending changes',
    keywords: ['offline', 'sync', 'connectivity', 'queue', 'pending', 'network'],
    icon: 'cloud-check-outline',
    section: 'General',
    route: ROUTES.APP.OFFLINE_SYNC,
  },

  // Notification categories --------------------------------------------------
  {
    id: SETTING_IDS.notifMaster,
    title: 'Allow notifications',
    subtitle: 'Master switch for remote push',
    keywords: ['notifications', 'push', 'enable', 'allow', 'master'],
    icon: 'bell-ring-outline',
    section: 'Notifications',
    route: ROUTES.APP.NOTIFICATION_SETTINGS,
  },
  {
    id: SETTING_IDS.notifMessages,
    title: 'Message notifications',
    subtitle: 'Chat messages from groups and direct chats',
    keywords: ['messages', 'chat', 'notifications'],
    icon: 'chat-outline',
    section: 'Notifications',
    route: ROUTES.APP.NOTIFICATION_SETTINGS,
  },
  {
    id: SETTING_IDS.notifExpenses,
    title: 'Expense notifications',
    subtitle: 'New expenses and split requests',
    keywords: ['expenses', 'notifications', 'split', 'bills'],
    icon: 'currency-usd',
    section: 'Notifications',
    route: ROUTES.APP.NOTIFICATION_SETTINGS,
  },
  {
    id: SETTING_IDS.notifSettlements,
    title: 'Settlement notifications',
    subtitle: 'Payment settlements and confirmations',
    keywords: ['settlements', 'payments', 'notifications'],
    icon: 'handshake-outline',
    section: 'Notifications',
    route: ROUTES.APP.NOTIFICATION_SETTINGS,
  },
  {
    id: SETTING_IDS.notifGroup,
    title: 'Group update notifications',
    subtitle: 'Members joining or leaving groups',
    keywords: ['group', 'updates', 'members', 'notifications'],
    icon: 'account-group-outline',
    section: 'Notifications',
    route: ROUTES.APP.NOTIFICATION_SETTINGS,
  },
  {
    id: SETTING_IDS.notifCalls,
    title: 'Call notifications',
    subtitle: 'Incoming voice and video call alerts',
    keywords: ['calls', 'voice', 'video', 'notifications'],
    icon: 'phone-ring-outline',
    section: 'Notifications',
    route: ROUTES.APP.NOTIFICATION_SETTINGS,
  },
  {
    id: SETTING_IDS.notifSounds,
    title: 'Notification sounds',
    subtitle: 'Play sounds for incoming notifications',
    keywords: ['sounds', 'audio', 'notifications'],
    icon: 'volume-high',
    section: 'Notifications',
    route: ROUTES.APP.NOTIFICATION_SETTINGS,
  },
  {
    id: SETTING_IDS.notifVibration,
    title: 'Vibration',
    subtitle: 'Vibrate when notifications arrive',
    keywords: ['vibration', 'haptics', 'notifications'],
    icon: 'vibrate',
    section: 'Notifications',
    route: ROUTES.APP.NOTIFICATION_SETTINGS,
  },
];
