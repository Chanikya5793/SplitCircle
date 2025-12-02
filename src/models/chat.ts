import type { PresenceStatus } from './user';

export type MessageType = 'text' | 'image' | 'audio' | 'file' | 'system' | 'call';
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
  duration?: number;
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
