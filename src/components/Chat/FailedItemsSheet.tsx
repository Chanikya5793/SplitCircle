// FailedItemsSheet — shows after a media batch finishes if any items failed
// to send. Each row carries the thumbnail, batch position, error reason, and
// per-item retry actions. Lives next to MediaPreview because it consumes the
// same `MediaPreviewSendItem` shape — failed items are just send-items that
// didn't make it through `sendMessage`.

import { useTheme } from '@/context/ThemeContext';
import { useVideoThumbnail } from '@/utils/videoThumbnail';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text } from 'react-native-paper';
import type { MediaPreviewSendItem } from './MediaPreview';

export interface FailedSendItem {
  /** Index in the original batch — preserved so the sheet can label "Item 4 of 10". */
  batchIndex: number;
  batchSize: number;
  /** The send-item we tried to push, including current quality + caption. */
  payload: MediaPreviewSendItem;
  /** Short, human-readable reason. We translate raw errors at insertion time. */
  reason: string;
  /** Whether the underlying error is "file too large" — drives Trim CTA. */
  isOversize: boolean;
  /** Stable message id from the first attempt. Retries reuse it so a
   *  successful resend upserts the failed bubble in chat instead of
   *  appending a duplicate `sent` bubble next to the failed one. */
  requestId: string;
}

interface FailedItemsSheetProps {
  visible: boolean;
  items: FailedSendItem[];
  onClose: () => void;
  onRetry: (item: FailedSendItem) => void;
  onTrimAndRetry: (item: FailedSendItem) => void;
  onRetryAll: () => void;
}

const Thumb = ({ item }: { item: FailedSendItem }) => {
  const media = item.payload.media;
  const isVideo = media.type === 'video';
  const isImage = media.type === 'image' || media.type === 'camera';
  const videoThumb = useVideoThumbnail(isVideo ? media.uri : undefined);
  const uri = isVideo ? videoThumb : isImage ? media.uri : undefined;

  return (
    <View style={styles.thumb}>
      {uri ? (
        <Image source={{ uri }} style={styles.thumbImage} resizeMode="cover" fadeDuration={0} />
      ) : (
        <View style={styles.thumbFallback}>
          <Ionicons
            name={
              media.type === 'audio'
                ? 'musical-notes'
                : media.type === 'document'
                ? 'document'
                : 'image'
            }
            size={20}
            color="#888"
          />
        </View>
      )}
      {isVideo && (
        <View style={styles.thumbVideoBadge}>
          <Ionicons name="play" size={10} color="#fff" />
        </View>
      )}
    </View>
  );
};

export const FailedItemsSheet = ({
  visible,
  items,
  onClose,
  onRetry,
  onTrimAndRetry,
  onRetryAll,
}: FailedItemsSheetProps) => {
  const { theme, isDark } = useTheme();

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType={Platform.OS === 'ios' ? 'slide' : 'fade'}
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[
            styles.sheet,
            { backgroundColor: isDark ? '#1c1c1e' : '#fff' },
          ]}
          onPress={() => undefined}
        >
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text variant="titleMedium" style={{ fontWeight: '700', color: theme.colors.onSurface }}>
                {items.length} {items.length === 1 ? 'item failed' : 'items failed'} to send
              </Text>
              <Text style={{ fontSize: 12.5, color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                Tap an item to retry, or trim oversized videos to fit.
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={24} color={theme.colors.onSurface} />
            </TouchableOpacity>
          </View>

          <FlatList
            data={items}
            keyExtractor={(it) => `${it.batchIndex}:${it.payload.media.uri}`}
            ItemSeparatorComponent={() => (
              <View
                style={{
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
                }}
              />
            )}
            renderItem={({ item }) => {
              const isVideo = item.payload.media.type === 'video';
              const canTrim = isVideo;
              return (
                <View style={styles.row}>
                  <Thumb item={item} />
                  <View style={styles.rowText}>
                    <Text style={[styles.rowTitle, { color: theme.colors.onSurface }]}>
                      Item {item.batchIndex + 1} of {item.batchSize}
                    </Text>
                    <Text
                      numberOfLines={2}
                      style={[styles.rowReason, { color: theme.colors.onSurfaceVariant }]}
                    >
                      {item.reason}
                    </Text>
                  </View>
                  <View style={styles.rowActions}>
                    {canTrim && (
                      <TouchableOpacity
                        style={[styles.actionBtn, { backgroundColor: 'rgba(228,83,83,0.14)' }]}
                        onPress={() => onTrimAndRetry(item)}
                      >
                        <Ionicons name="cut-outline" size={16} color="#E45353" />
                        <Text style={[styles.actionBtnText, { color: '#E45353' }]}>Trim</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={[
                        styles.actionBtn,
                        { backgroundColor: theme.colors.primaryContainer ?? 'rgba(53,198,255,0.14)' },
                      ]}
                      onPress={() => onRetry(item)}
                    >
                      <Ionicons name="refresh" size={16} color={theme.colors.primary} />
                      <Text style={[styles.actionBtnText, { color: theme.colors.primary }]}>Retry</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            }}
          />

          {items.length > 1 && (
            <TouchableOpacity
              style={[styles.retryAll, { backgroundColor: theme.colors.primary }]}
              onPress={onRetryAll}
            >
              <Ionicons name="refresh" size={16} color={theme.colors.onPrimary} />
              <Text style={[styles.retryAllText, { color: theme.colors.onPrimary }]}>
                Retry all {items.length}
              </Text>
            </TouchableOpacity>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 24,
    maxHeight: '85%',
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#888',
    marginTop: 8,
    marginBottom: 4,
    opacity: 0.4,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#222',
  },
  thumbImage: { width: '100%', height: '100%' },
  thumbFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbVideoBadge: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  rowReason: {
    fontSize: 12,
    marginTop: 2,
  },
  rowActions: {
    flexDirection: 'row',
    gap: 6,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  actionBtnText: {
    fontSize: 12.5,
    fontWeight: '600',
  },
  retryAll: {
    marginHorizontal: 16,
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  retryAllText: {
    fontSize: 14,
    fontWeight: '700',
  },
});

export default FailedItemsSheet;
