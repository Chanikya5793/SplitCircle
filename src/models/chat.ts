import type { PresenceStatus } from './user';

export type MessageType = 'text' | 'image' | 'video' | 'audio' | 'file' | 'location' | 'system' | 'call';
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface ChatParticipant {
  userId: string;
  displayName: string;
  photoURL?: string;
  status: PresenceStatus;
}

export interface ReplyTo {
  messageId: string;
  senderId: string;
  senderName: string;
  content: string;
  type?: MessageType; // To show appropriate icon for media replies
}

export interface MediaMetadata {
  fileName?: string;
  fileSize?: number; // in bytes — the *sent* file's size after processing
  mimeType?: string;
  width?: number; // sent (post-process) width in display space
  height?: number; // sent (post-process) height in display space
  duration?: number; // for audio/video in ms
  aspectRatio?: number; // width/height
  thumbnailUri?: string; // for video thumbnails
  /** Stable id shared by all messages from the same multi-pick batch. Used by the chat list to render an album bubble grouping siblings into one grid. */
  albumId?: string;
  /** 0-based position of this item within its album (in pick / send order). */
  albumIndex?: number;
  /** Total number of items in this album. */
  albumSize?: number;
  // ── Source (pre-process) metadata ─────────────────────────────────────────
  // Captured natively from the source file before resize/transcode so the
  // info panel can report the exact dimensions / size the user picked,
  // independently of the compressed wire representation. Populated on the
  // sender; forwarded verbatim to receivers.
  /** Orientation-corrected pixel width of the original source file. */
  sourceWidth?: number;
  /** Orientation-corrected pixel height of the original source file. */
  sourceHeight?: number;
  /** Original file size in bytes before processing. */
  sourceFileSize?: number;
  /** EXIF-reported camera maker, e.g. "Apple" or "Samsung". */
  cameraMake?: string;
  /** EXIF-reported camera model, e.g. "iPhone 15 Pro". */
  cameraModel?: string;
  /** Unix ms when the image was captured (parsed from EXIF DateTimeOriginal). */
  takenAt?: number;
}

export interface LocationData {
  latitude: number;
  longitude: number;
  address?: string;
}

export interface UrlPreview {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
  /** Set to true when fetch failed or no metadata could be parsed; UI falls back to a plain link card. */
  failed?: boolean;
}

export interface ForwardedFrom {
  /** Original sender display name at the time of forward. */
  senderName?: string;
  /** Hop count — increments each time a message is forwarded. WhatsApp-style "forwarded many times" hint when >= 4. */
  hopCount: number;
}

/**
 * Map of emoji → array of userIds who reacted with that emoji.
 * Stored locally; cross-device sync is queued via reaction events on the chat thread (see Phase 2).
 */
export type ReactionMap = Record<string, string[]>;

export interface ChatMessage {
  id: string;
  messageId: string;
  requestId?: string;
  chatId: string;
  senderId: string;
  type: MessageType;
  content: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  mediaMetadata?: MediaMetadata;
  localMediaPath?: string; // Local file path for downloaded media
  mediaDownloaded?: boolean; // Whether media has been downloaded locally
  location?: LocationData;
  status: MessageStatus;
  createdAt: number;
  timestamp: number | Date;
  isFromMe?: boolean;
  deliveredTo: string[];
  readBy: string[];
  replyTo?: ReplyTo;
  // WhatsApp-parity fields — local-first, sync deferred to Phase 2.
  reactions?: ReactionMap;
  starredBy?: string[];
  /** UserIds who hid this message client-side via "Delete for me". */
  deletedFor?: string[];
  forwardedFrom?: ForwardedFrom;
  urlPreview?: UrlPreview;
  /** Edit metadata — when present, the bubble shows an "edited" tag. */
  editedAt?: number;
  /** Sender deleted this message for all participants. Bubble renders as tombstone. */
  deletedForEveryone?: boolean;
  /** UserIds @-mentioned in this message — used to highlight bubbles when the current user is mentioned. */
  mentions?: string[];
}

export interface PinnedMessageRef {
  messageId: string;
  pinnedBy: string;
  pinnedAt: number;
  /** Snapshot of content/type at pin time so the pin bar renders even before local message store has caught up. */
  contentPreview?: string;
  type?: MessageType;
  senderId?: string;
}

export interface ChatThread {
  chatId: string;
  type: 'direct' | 'group';
  participants: ChatParticipant[];
  participantIds: string[];
  lastMessage?: ChatMessage;
  unreadCount: number;
  groupId?: string;
  updatedAt?: number;
  pinnedMessages?: PinnedMessageRef[];
  /** Map of userId → ms epoch when they were last seen typing. Cleared by clients after staleness. */
  typing?: Record<string, number>;
}
