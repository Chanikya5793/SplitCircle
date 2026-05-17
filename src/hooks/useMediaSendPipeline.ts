import type { FailedSendItem } from '@/components/Chat';
import type { SelectedMedia } from '@/components/Chat/AttachmentMenu';
import type { MediaPreviewSendItem } from '@/components/Chat/MediaPreview';
import type { ChatMessage, ChatParticipant, MessageType } from '@/models';
import { processImage, processVideo } from '@/services/mediaProcessingService';
import { trimVideoInteractive } from '@/services/videoTrimService';
import { warningHaptic } from '@/utils/haptics';
import { getInfoAsync } from 'expo-file-system/legacy';
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { v4 as uuid } from 'uuid';

type SendContext = {
  indexLabel: { current: number; total: number };
  albumId?: string;
  replyTarget?: ChatMessage | null;
  requestId: string;
};

interface UseMediaSendPipelineOptions {
  chatId: string;
  groupId?: string;
  participants: ChatParticipant[];
  mediaPipelineLoading: {
    start: (message?: string) => void;
    stop: () => void;
    setMessage: (message?: string) => void;
  };
  runSend: (
    fn: (requestId: string) => Promise<void>,
    opts?: { key?: string },
  ) => Promise<void>;
  sendMessage: (params: {
    chatId: string;
    requestId: string;
    content: string;
    type: MessageType;
    mediaUri?: string;
    groupId?: string;
    replyTo?: any;
    mediaMetadata?: any;
    onStageChange?: (stage: string, details?: { message?: string }) => void;
  }) => Promise<void>;
}

const getProcessingLoadingMessage = (type: SelectedMedia['type']) => {
  switch (type) {
    case 'video':
      return 'Preparing video for upload…';
    case 'image':
    case 'camera':
      return 'Optimizing photo…';
    case 'document':
      return 'Preparing document…';
    case 'audio':
      return 'Preparing audio…';
    default:
      return 'Preparing attachment…';
  }
};

const getMediaPlaceholder = (type: MessageType): string => {
  switch (type) {
    case 'image': return '📷 Photo';
    case 'video': return '🎥 Video';
    case 'audio': return '🎵 Audio';
    case 'file': return '📄 Document';
    case 'location': return '📍 Location';
    default: return '📎 Attachment';
  }
};

export const useMediaSendPipeline = ({
  chatId,
  groupId,
  participants,
  mediaPipelineLoading,
  runSend,
  sendMessage,
}: UseMediaSendPipelineOptions) => {
  const [failedItems, setFailedItems] = useState<FailedSendItem[]>([]);
  const [failedSheetVisible, setFailedSheetVisible] = useState(false);

  const sendOneMedia = useCallback(async (item: MediaPreviewSendItem, ctx: SendContext) => {
    const { media: mediaToSend, caption, quality: itemQuality } = item;
    const { current, total } = ctx.indexLabel;
    const positional = total > 1 ? `${current} of ${total}` : null;

    let processedUri = mediaToSend.uri;
    let processedWidth = mediaToSend.width;
    let processedHeight = mediaToSend.height;
    let processedSize = mediaToSend.fileSize;
    let sourceWidth: number | undefined;
    let sourceHeight: number | undefined;
    let sourceFileSize: number | undefined;
    let cameraMake: string | undefined;
    let cameraModel: string | undefined;
    let takenAt: number | undefined;

    if (mediaToSend.type === 'image' || mediaToSend.type === 'camera') {
      const r = await processImage(mediaToSend.uri, itemQuality);
      processedUri = r.uri;
      processedWidth = r.width;
      processedHeight = r.height;
      processedSize = r.size;
      sourceWidth = r.sourceWidth;
      sourceHeight = r.sourceHeight;
      sourceFileSize = r.sourceFileSize;
      cameraMake = r.cameraMake;
      cameraModel = r.cameraModel;
      takenAt = r.takenAt;
    } else if (mediaToSend.type === 'video') {
      const r = await processVideo(mediaToSend.uri, itemQuality, (p) => {
        const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
        mediaPipelineLoading.setMessage(
          positional
            ? `Compressing ${positional} — ${pct}%`
            : `Compressing video — ${pct}%`,
        );
      });
      processedUri = r.uri;
      if (r.width > 0) processedWidth = r.width;
      if (r.height > 0) processedHeight = r.height;
      processedSize = r.size;
      sourceWidth = r.sourceWidth || undefined;
      sourceHeight = r.sourceHeight || undefined;
      sourceFileSize = r.sourceFileSize || undefined;
    }

    let messageType: MessageType;
    switch (mediaToSend.type) {
      case 'camera':
      case 'image':
        messageType = 'image';
        break;
      case 'video':
        messageType = 'video';
        break;
      case 'audio':
        messageType = 'audio';
        break;
      case 'document':
        messageType = 'file';
        break;
      case 'location':
        messageType = 'location';
        break;
      default:
        messageType = 'file';
    }

    let replyData: any = undefined;
    if (ctx.replyTarget) {
      const replySource = ctx.replyTarget;
      const participant = participants.find((p) => p.userId === replySource.senderId);
      replyData = {
        messageId: replySource.messageId,
        senderId: replySource.senderId,
        senderName: participant?.displayName || 'Unknown',
        content: replySource.content,
        type: replySource.type,
      };
    }

    const mediaMetadata: Record<string, unknown> = {};
    if (mediaToSend.fileName) mediaMetadata.fileName = mediaToSend.fileName;
    if (processedSize) mediaMetadata.fileSize = processedSize;
    if (mediaToSend.mimeType) mediaMetadata.mimeType = mediaToSend.mimeType;
    if (processedWidth) mediaMetadata.width = processedWidth;
    if (processedHeight) mediaMetadata.height = processedHeight;
    if (mediaToSend.duration) mediaMetadata.duration = mediaToSend.duration;
    if (processedWidth && processedHeight) {
      mediaMetadata.aspectRatio = processedWidth / processedHeight;
    }
    if (ctx.albumId) {
      mediaMetadata.albumId = ctx.albumId;
      mediaMetadata.albumIndex = current - 1;
      mediaMetadata.albumSize = total;
    }
    if (sourceWidth) mediaMetadata.sourceWidth = sourceWidth;
    if (sourceHeight) mediaMetadata.sourceHeight = sourceHeight;
    if (sourceFileSize) mediaMetadata.sourceFileSize = sourceFileSize;
    if (cameraMake) mediaMetadata.cameraMake = cameraMake;
    if (cameraModel) mediaMetadata.cameraModel = cameraModel;
    if (takenAt) mediaMetadata.takenAt = takenAt;

    mediaPipelineLoading.setMessage(
      positional
        ? `Uploading ${positional}…`
        : `Uploading ${mediaToSend.type === 'video' ? 'video' : 'attachment'}…`,
    );

    await runSend(async () => {
      await sendMessage({
        chatId,
        requestId: ctx.requestId,
        content: caption || getMediaPlaceholder(messageType),
        type: messageType,
        mediaUri: processedUri,
        groupId,
        replyTo: replyData,
        mediaMetadata: Object.keys(mediaMetadata).length > 0 ? (mediaMetadata as any) : undefined,
        onStageChange: (stage, details) => {
          if (stage === 'complete') return;
          if (details?.message) {
            mediaPipelineLoading.setMessage(
              positional ? `${positional} — ${details.message}` : details.message,
            );
          }
        },
      });
    }, { key: `chat-media-${chatId}-${ctx.requestId}` });
  }, [chatId, groupId, participants, mediaPipelineLoading, runSend, sendMessage]);

  const buildFailedItem = useCallback((
    payload: MediaPreviewSendItem,
    batchIndex: number,
    batchSize: number,
    requestId: string,
    error: unknown,
  ): FailedSendItem => {
    const name = error instanceof Error ? error.name : '';
    const raw = error instanceof Error ? error.message : 'Failed to send';
    const isOversize = /too large|maximum size|exceeds/i.test(raw);
    let reason = raw;
    if (isOversize) {
      reason = 'File too large after compression — trim or switch to SD.';
    } else if (name === 'MediaSourceUnavailableError' || name === 'MediaCopyFailedError') {
      reason = raw;
    } else if (/iCloud|PHPhotosErrorDomain|3164|asset not available|network access/i.test(raw)) {
      reason = 'Couldn’t download this item from iCloud. Open it once in Photos, then retry.';
    } else if (/ENOENT|no such file/i.test(raw)) {
      reason = 'Source file is no longer available. Pick it again.';
    } else if (/permission|denied|EACCES/i.test(raw)) {
      reason = 'Permission denied while reading the file. Check Photos / Files access.';
    } else if (/Not authenticated/i.test(raw)) {
      reason = 'You’re signed out. Sign in and try again.';
    } else if (/network|offline|timeout|Network request failed/i.test(raw)) {
      reason = 'Network error — check your connection and retry.';
    } else if (/Unsupported media type/i.test(raw)) {
      reason = 'This file type isn’t supported.';
    }
    return { batchIndex, batchSize, payload, reason, isOversize, requestId };
  }, []);

  const removeFailedItem = useCallback((batchIndex: number, mediaUri: string) => {
    setFailedItems((prev) => prev.filter((f) => !(f.batchIndex === batchIndex && f.payload.media.uri === mediaUri)));
  }, []);

  const retrySingleFailedItem = useCallback(async (item: FailedSendItem) => {
    mediaPipelineLoading.start(getProcessingLoadingMessage(item.payload.media.type));
    try {
      await sendOneMedia(item.payload, {
        indexLabel: { current: 1, total: 1 },
        requestId: item.requestId,
      });
      removeFailedItem(item.batchIndex, item.payload.media.uri);
    } catch (err) {
      console.error('Retry failed:', err);
      setFailedItems((prev) =>
        prev.map((f) =>
          f.batchIndex === item.batchIndex && f.payload.media.uri === item.payload.media.uri
            ? buildFailedItem(item.payload, item.batchIndex, item.batchSize, item.requestId, err)
            : f,
        ),
      );
    } finally {
      mediaPipelineLoading.stop();
    }
  }, [sendOneMedia, mediaPipelineLoading, removeFailedItem, buildFailedItem]);

  const handleRetryAllFailedItems = useCallback(async () => {
    const snapshot = [...failedItems];
    if (snapshot.length === 0) return;
    setFailedSheetVisible(false);
    for (const item of snapshot) {
      await retrySingleFailedItem(item);
    }
    setFailedItems((current) => {
      if (current.length > 0) setFailedSheetVisible(true);
      return current;
    });
  }, [failedItems, retrySingleFailedItem]);

  const handleTrimAndRetryFailedItem = useCallback(async (item: FailedSendItem) => {
    if (item.payload.media.type !== 'video') return;
    setFailedSheetVisible(false);
    try {
      const trimmed = await trimVideoInteractive(item.payload.media.uri, {
        headerText: 'Trim to fit',
      });
      if (!trimmed) {
        setFailedSheetVisible(true);
        return;
      }
      let newSize = 0;
      try {
        const info = await getInfoAsync(trimmed.outputPath);
        newSize = info.exists && 'size' in info ? info.size : 0;
      } catch {
        /* swallow — size will be filled in by processVideo's read */
      }
      const updated: FailedSendItem = {
        ...item,
        payload: {
          ...item.payload,
          media: {
            ...item.payload.media,
            uri: trimmed.outputPath,
            duration: trimmed.durationMs,
            fileSize: newSize > 0 ? newSize : item.payload.media.fileSize,
          },
        },
      };
      await retrySingleFailedItem(updated);
      setFailedItems((current) => {
        if (current.length > 0) setFailedSheetVisible(true);
        return current;
      });
    } catch (err) {
      console.error('Trim & retry failed:', err);
      Alert.alert('Couldn’t trim video', err instanceof Error ? err.message : 'Please try again.');
      setFailedSheetVisible(true);
    }
  }, [retrySingleFailedItem]);

  const handleSendMedia = useCallback(async (
    results: MediaPreviewSendItem[],
    replySource: ChatMessage | null,
    onDismissPreview: () => void,
  ) => {
    if (results.length === 0) return;

    onDismissPreview();

    mediaPipelineLoading.start(
      results.length > 1
        ? `Preparing 1 of ${results.length}…`
        : getProcessingLoadingMessage(results[0].media.type),
    );

    const isAlbum =
      results.length > 1 &&
      results.every(({ media }) =>
        media.type === 'image' ||
        media.type === 'camera' ||
        media.type === 'video',
      );
    const albumId = isAlbum ? `album_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : undefined;

    const failures: FailedSendItem[] = [];
    try {
      for (let i = 0; i < results.length; i++) {
        if (results.length > 1) {
          mediaPipelineLoading.setMessage(`Preparing ${i + 1} of ${results.length}…`);
        } else {
          mediaPipelineLoading.setMessage(getProcessingLoadingMessage(results[i].media.type));
        }

        const requestId = uuid();
        try {
          await sendOneMedia(results[i], {
            indexLabel: { current: i + 1, total: results.length },
            albumId,
            replyTarget: i === 0 ? replySource : null,
            requestId,
          });
        } catch (itemError) {
          console.error(`Failed to send batch item ${i}:`, itemError);
          failures.push(buildFailedItem(results[i], i, results.length, requestId, itemError));
        }
      }
    } finally {
      mediaPipelineLoading.stop();
    }

    if (failures.length > 0) {
      setFailedItems(failures);
      setFailedSheetVisible(true);
      warningHaptic();
    }
  }, [sendOneMedia, buildFailedItem, mediaPipelineLoading]);

  return {
    failedItems,
    failedSheetVisible,
    setFailedSheetVisible,
    handleSendMedia,
    retrySingleFailedItem,
    handleRetryAllFailedItems,
    handleTrimAndRetryFailedItem,
  };
};
