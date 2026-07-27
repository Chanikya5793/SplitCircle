import type { FailedSendItem } from '@/components/Chat';
import type { SelectedMedia } from '@/components/Chat/AttachmentMenu';
import type { MediaPreviewSendItem } from '@/components/Chat/MediaPreview';
import { useAuth } from '@/context/AuthContext';
import { appAlert } from '@/utils/appAlert';
import type { ChatMessage, ChatParticipant, MessageType } from '@/models';
import { saveMessageLocally, deleteMessageLocally } from '@/services/localMessageStorage';
import { processImage, processVideo } from '@/services/mediaProcessingService';
import {
  clearSendProgress,
  MediaSendCancelledError,
  setSendFraction,
  setSendProgress,
} from '@/services/mediaSendProgress';
import { trimVideoInteractive } from '@/services/videoTrimService';
import { warningHaptic } from '@/utils/haptics';
import { resolveDisplayName } from '@/utils/identity';
import { getInfoAsync } from 'expo-file-system/legacy';
import { useCallback, useState } from 'react';
import { v4 as uuid } from 'uuid';

interface UseMediaSendPipelineOptions {
  chatId: string;
  groupId?: string;
  participants: ChatParticipant[];
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

const toMessageType = (type: SelectedMedia['type']): MessageType => {
  switch (type) {
    case 'camera':
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'document':
      return 'file';
    case 'location':
      return 'location';
    default:
      return 'file';
  }
};

/** One item's worth of in-flight state, threaded through both pipeline stages. */
interface MediaJob {
  item: MediaPreviewSendItem;
  /** 1-based position for user-facing labels. */
  position: number;
  total: number;
  requestId: string;
  albumId?: string;
  replyTarget?: ChatMessage | null;
  /** Set by the bubble's Cancel control. Checked at every stage boundary so an
   *  item cancelled while queued never starts work at all. */
  cancelled: boolean;
}

/** What compression produced, handed to the upload stage. */
interface PreparedMedia {
  processedUri: string;
  messageType: MessageType;
  mediaMetadata: Record<string, unknown>;
}

export const useMediaSendPipeline = ({
  chatId,
  groupId,
  participants,
  runSend,
  sendMessage,
}: UseMediaSendPipelineOptions) => {
  const [failedItems, setFailedItems] = useState<FailedSendItem[]>([]);
  const [failedSheetVisible, setFailedSheetVisible] = useState(false);
  const { user } = useAuth();

  /**
   * Write the optimistic bubble BEFORE any compression starts.
   *
   * This is what fixes the "I tapped Send and nothing happened" report. The
   * bubble used to be created inside `sendMessage`, which the pipeline only
   * reached AFTER compression — so a 60-second video transcode showed an
   * unchanged chat with a thin banner over it. Now the photo appears in the
   * thread on tap, at its ORIGINAL uri, and the compressed file replaces it
   * in place when `sendMessage` later saves the same message id.
   */
  const createPlaceholder = useCallback(async (job: MediaJob) => {
    if (!user) return;
    const { media, caption } = job.item;
    const messageType = toMessageType(media.type);
    // Offset by position so a batch saved within the same millisecond still
    // sorts in the order the user picked — the list sorts by timestamp.
    const now = Date.now() + job.position;

    const metadata: Record<string, unknown> = {};
    if (media.fileName) metadata.fileName = media.fileName;
    if (media.fileSize) metadata.fileSize = media.fileSize;
    if (media.mimeType) metadata.mimeType = media.mimeType;
    if (media.width) metadata.width = media.width;
    if (media.height) metadata.height = media.height;
    if (media.duration) metadata.duration = media.duration;
    if (media.width && media.height) metadata.aspectRatio = media.width / media.height;
    if (job.albumId) {
      metadata.albumId = job.albumId;
      metadata.albumIndex = job.position - 1;
      metadata.albumSize = job.total;
    }

    const placeholder: ChatMessage = {
      id: job.requestId,
      messageId: job.requestId,
      requestId: job.requestId,
      chatId,
      senderId: user.userId,
      type: messageType,
      content: caption || getMediaPlaceholder(messageType),
      localMediaPath: media.uri,
      mediaDownloaded: true,
      mediaMetadata: metadata as any,
      status: 'sending',
      createdAt: now,
      timestamp: now,
      isFromMe: true,
      deliveredTo: [],
      readBy: [],
    };

    setSendProgress(job.requestId, { stage: 'queued', fraction: null });
    await saveMessageLocally(placeholder);
  }, [chatId, user]);

  /**
   * Stage 1 — compress. CPU-bound, so callers run these strictly one at a
   * time; two concurrent transcodes on a phone are slower than two sequential
   * ones and starve the UI thread.
   */
  const compressOne = useCallback(async (job: MediaJob): Promise<PreparedMedia> => {
    const { media: mediaToSend, quality: itemQuality } = job.item;
    const { requestId } = job;

    if (job.cancelled) throw new MediaSendCancelledError();

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
      setSendProgress(requestId, { stage: 'compressing', fraction: 0 });
      const r = await processVideo(
        mediaToSend.uri,
        itemQuality,
        (p) => setSendFraction(requestId, Math.max(0, Math.min(1, p))),
        (cancel) => setSendProgress(requestId, { stage: 'compressing', cancel }),
      );
      processedUri = r.uri;
      if (r.width > 0) processedWidth = r.width;
      if (r.height > 0) processedHeight = r.height;
      processedSize = r.size;
      sourceWidth = r.sourceWidth || undefined;
      sourceHeight = r.sourceHeight || undefined;
      sourceFileSize = r.sourceFileSize || undefined;
    }

    // A cancel that landed mid-transcode: the native module may still resolve
    // normally, so re-check rather than assuming it threw.
    if (job.cancelled) throw new MediaSendCancelledError();

    const messageType = toMessageType(mediaToSend.type);

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
    if (job.albumId) {
      mediaMetadata.albumId = job.albumId;
      mediaMetadata.albumIndex = job.position - 1;
      mediaMetadata.albumSize = job.total;
    }
    if (sourceWidth) mediaMetadata.sourceWidth = sourceWidth;
    if (sourceHeight) mediaMetadata.sourceHeight = sourceHeight;
    if (sourceFileSize) mediaMetadata.sourceFileSize = sourceFileSize;
    if (cameraMake) mediaMetadata.cameraMake = cameraMake;
    if (cameraModel) mediaMetadata.cameraModel = cameraModel;
    if (takenAt) mediaMetadata.takenAt = takenAt;

    return { processedUri, messageType, mediaMetadata };
  }, []);

  /**
   * Stage 2 — upload and fan out. Network-bound, so this runs on its own
   * chain and overlaps with the NEXT item's compression. That overlap is the
   * whole point of the split: before it, a batch cost
   * `sum(compress) + sum(upload)`; now it costs roughly
   * `max(sum(compress), sum(upload))` plus one item's worth of latency.
   */
  const dispatchOne = useCallback(async (job: MediaJob, prepared: PreparedMedia) => {
    if (job.cancelled) throw new MediaSendCancelledError();

    let replyData: any = undefined;
    if (job.replyTarget) {
      const replySource = job.replyTarget;
      const participant = participants.find((p) => p.userId === replySource.senderId);
      replyData = {
        messageId: replySource.messageId,
        senderId: replySource.senderId,
        senderName: resolveDisplayName(participant, 'Unknown'),
        content: replySource.content,
        type: replySource.type,
      };
    }

    await runSend(async () => {
      await sendMessage({
        chatId,
        requestId: job.requestId,
        content: job.item.caption || getMediaPlaceholder(prepared.messageType),
        type: prepared.messageType,
        mediaUri: prepared.processedUri,
        groupId,
        replyTo: replyData,
        mediaMetadata: Object.keys(prepared.mediaMetadata).length > 0
          ? (prepared.mediaMetadata as any)
          : undefined,
      });
    }, { key: `chat-media-${chatId}-${job.requestId}` });
  }, [chatId, groupId, participants, runSend, sendMessage]);

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
    // Reuses the original requestId, so the retry addresses the same message
    // id and progress slot rather than leaving an orphaned bubble behind.
    const job: MediaJob = {
      item: item.payload,
      position: 1,
      total: 1,
      requestId: item.requestId,
      replyTarget: null,
      cancelled: false,
    };
    try {
      await createPlaceholder(job);
      setSendProgress(job.requestId, {
        stage: 'queued',
        fraction: null,
        cancel: () => {
          job.cancelled = true;
        },
      });
      const prepared = await compressOne(job);
      await dispatchOne(job, prepared);
      clearSendProgress(job.requestId);
      removeFailedItem(item.batchIndex, item.payload.media.uri);
    } catch (err) {
      clearSendProgress(job.requestId);
      const cancelled =
        err instanceof Error &&
        (err.name === 'MediaSendCancelledError' || err.name === 'MediaUploadCancelledError');
      if (cancelled) {
        await deleteMessageLocally(chatId, job.requestId);
        removeFailedItem(item.batchIndex, item.payload.media.uri);
        return;
      }
      console.error('Retry failed:', err);
      setFailedItems((prev) =>
        prev.map((f) =>
          f.batchIndex === item.batchIndex && f.payload.media.uri === item.payload.media.uri
            ? buildFailedItem(item.payload, item.batchIndex, item.batchSize, item.requestId, err)
            : f,
        ),
      );
    }
  }, [chatId, createPlaceholder, compressOne, dispatchOne, removeFailedItem, buildFailedItem]);

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
      appAlert('Couldn’t trim video', err instanceof Error ? err.message : 'Please try again.');
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

    const isAlbum =
      results.length > 1 &&
      results.every(({ media }) =>
        media.type === 'image' ||
        media.type === 'camera' ||
        media.type === 'video',
      );
    const albumId = isAlbum ? `album_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : undefined;

    const jobs: MediaJob[] = results.map((item, i) => ({
      item,
      position: i + 1,
      total: results.length,
      requestId: uuid(),
      albumId,
      replyTarget: i === 0 ? replySource : null,
      cancelled: false,
    }));

    // Every bubble appears at once, before a single byte is processed. The
    // user sees exactly what they picked, in order, immediately.
    for (const job of jobs) {
      await createPlaceholder(job);
      setSendProgress(job.requestId, {
        stage: 'queued',
        fraction: null,
        cancel: () => {
          job.cancelled = true;
        },
      });
    }

    const failures: FailedSendItem[] = [];
    const noteFailure = (job: MediaJob, error: unknown) => {
      clearSendProgress(job.requestId);
      // A cancel is not a failure — the bubble is already gone and the user
      // does not want to be asked to retry what they just stopped.
      if (error instanceof Error && error.name === 'MediaSendCancelledError') return;
      if (error instanceof Error && error.name === 'MediaUploadCancelledError') return;
      console.error(`Failed to send batch item ${job.position - 1}:`, error);
      failures.push(
        buildFailedItem(job.item, job.position - 1, job.total, job.requestId, error),
      );
    };

    // Two-stage pipeline. Compression stays strictly sequential (CPU-bound —
    // concurrent transcodes on a phone are slower than serial ones and starve
    // the UI thread), while uploads run on their own chain so item N uploads
    // WHILE item N+1 compresses. The chain also preserves order, which an
    // album depends on.
    let uploadChain: Promise<void> = Promise.resolve();

    for (const job of jobs) {
      let prepared: PreparedMedia;
      try {
        prepared = await compressOne(job);
      } catch (error) {
        // A cancelled placeholder has no send to clean it up, so remove it here.
        if (error instanceof Error && error.name === 'MediaSendCancelledError') {
          await deleteMessageLocally(chatId, job.requestId);
        }
        noteFailure(job, error);
        continue;
      }

      const readyJob = job;
      const readyMedia = prepared;
      uploadChain = uploadChain.then(async () => {
        try {
          await dispatchOne(readyJob, readyMedia);
          clearSendProgress(readyJob.requestId);
        } catch (error) {
          if (error instanceof Error && error.name === 'MediaSendCancelledError') {
            await deleteMessageLocally(chatId, readyJob.requestId);
          }
          noteFailure(readyJob, error);
        }
      });
    }

    await uploadChain;

    if (failures.length > 0) {
      setFailedItems(failures);
      setFailedSheetVisible(true);
      warningHaptic();
    }
  }, [chatId, createPlaceholder, compressOne, dispatchOne, buildFailedItem]);

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
