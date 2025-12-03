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
  fileSize?: number; // in bytes
  mimeType?: string;
  width?: number; // for images/videos
  height?: number; // for images/videos
  duration?: number; // for audio/video in ms
  aspectRatio?: number; // width/height
  thumbnailUri?: string; // for video thumbnails
}

export interface LocationData {
  latitude: number;
  longitude: number;
  address?: string;
}

export interface ChatMessage {
  id: string;
  messageId: string;
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
}
