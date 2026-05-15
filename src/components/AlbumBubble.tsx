import { ReactionsRow } from '@/components/Chat/ReactionsRow';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatMessage } from '@/models';
import { formatRelativeTime } from '@/utils/format';
import { useResolvedMediaUri } from '@/utils/useResolvedMediaUri';
import { useCachedVideoThumbnail } from '@/utils/videoThumbnail';
import { buildStamp } from '@/services/messageRenderCache';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Image,
  StyleSheet,
  TouchableOpacity,
  View,
  type ViewStyle,
} from 'react-native';
import { Text } from 'react-native-paper';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const ALBUM_WIDTH = Math.min(280, Math.round(SCREEN_WIDTH * 0.72));
const GAP = 2;

const AVATAR_COLORS = [
  '#E57373', '#F06292', '#BA68C8', '#9575CD', '#7986CB',
  '#64B5F6', '#4FC3F7', '#4DD0E1', '#4DB6AC', '#81C784',
  '#AED581', '#FF8A65', '#D4E157', '#FFD54F', '#FFB74D',
];
const senderColor = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};

interface AlbumBubbleProps {
  /** Album members ordered oldest → newest (i.e. pick order). */
  messages: ChatMessage[];
  showSenderInfo?: boolean;
  senderName?: string;
  isGroupChat?: boolean;
  onMediaPress?: (message: ChatMessage) => void;
  /** Long-press on any cell — passes the album anchor so action-sheet ops apply album-wide. */
  onLongPress?: (anchor: ChatMessage) => void;
  /** Tap on the existing reactions chip — opens the reactions detail sheet for the anchor. */
  onReactionsPress?: (anchor: ChatMessage) => void;
  onReplyPress?: (messageId: string) => void;
  highlighted?: boolean;
  dimmed?: boolean;
  /** When true, taps toggle selection on the tapped cell (long-press still works). */
  selectionMode?: boolean;
  /** Set of selected messageIds (or .id) so each cell can show its checkbox state. */
  selectedIds?: Set<string>;
  onToggleSelect?: (message: ChatMessage) => void;
}

interface AlbumCellProps {
  message: ChatMessage;
  style: ViewStyle;
  onPress: () => void;
  onLongPress: () => void;
  showOverflow: boolean;
  overflowCount: number;
  selected?: boolean;
  selectionMode?: boolean;
  primaryColor: string;
}

const AlbumCell = ({
  message,
  style,
  onPress,
  onLongPress,
  showOverflow,
  overflowCount,
  selected,
  selectionMode,
  primaryColor,
}: AlbumCellProps) => {
  const isVideo = message.type === 'video';
  const isUploading = message.status === 'sending';

  // Resolve the URI through the shared hook so missing/stale local files
  // automatically fall back to the remote URL (and trigger a background
  // download for next time). Previously this used `localMediaPath ?? mediaUrl`
  // which left cells silently dark when the local file was gone.
  const resolved = useResolvedMediaUri({
    type: message.type,
    localMediaPath: message.localMediaPath,
    mediaUrl: message.mediaUrl,
    isFromMe: message.isFromMe,
    chatId: message.chatId,
    messageId: message.messageId || message.id,
    fileName: message.mediaMetadata?.fileName,
    // Cache version stamp — passing the mutable fields lets the render
    // cache automatically invalidate when the message is edited / its
    // status changes / it's marked deleted-for-everyone.
    createdAt: message.createdAt,
    timestamp: typeof message.timestamp === 'number' ? message.timestamp : message.timestamp?.getTime(),
    editedAt: message.editedAt,
    status: message.status,
    deletedForEveryone: message.deletedForEveryone,
  });

  // Videos render a generated frame as their thumbnail; the resolver still
  // gives us the underlying file we should pull that frame from. The
  // persistent variant survives app launches so we don't regenerate the
  // frame on every cold start.
  const videoThumb = useCachedVideoThumbnail({
    videoUri: isVideo ? resolved.uri : undefined,
    chatId: message.chatId,
    messageId: message.messageId || message.id,
    stamp: buildStamp({
      createdAt: message.createdAt,
      timestamp: typeof message.timestamp === 'number' ? message.timestamp : message.timestamp?.getTime(),
      editedAt: message.editedAt,
      status: message.status,
      deletedForEveryone: message.deletedForEveryone,
    }),
  });
  const displayUri = isVideo ? videoThumb : resolved.uri;
  // While the video thumbnail is being generated, surface the same spinner
  // we use during downloads so the cell isn't silently dark.
  const showSpinner = resolved.isDownloading || (isVideo && !displayUri && !resolved.errored && !!resolved.uri);

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.85}
      style={[
        styles.cell,
        style,
        selected && {
          // Slight inset look so selected cells stand out without changing layout.
          borderWidth: 3,
          borderColor: primaryColor,
        },
      ]}
    >
      {displayUri ? (
        <Image
          source={{ uri: displayUri }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          fadeDuration={0}
          progressiveRenderingEnabled
          onError={resolved.handleLoadError}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.cellPlaceholder]}>
          {resolved.errored ? (
            <Ionicons name="alert-circle-outline" size={26} color="#E45353" />
          ) : (
            <Ionicons
              name={isVideo ? 'videocam-outline' : 'image-outline'}
              size={28}
              color="#aaa"
            />
          )}
        </View>
      )}
      {showSpinner && (
        <View style={[StyleSheet.absoluteFill, styles.cellSpinnerOverlay]}>
          <ActivityIndicator size="small" color="#fff" />
        </View>
      )}
      {isVideo && !showOverflow && !selectionMode && (
        <View style={styles.playBadge}>
          <Ionicons name="play" size={18} color="#fff" />
        </View>
      )}
      {isUploading && (
        <View style={styles.uploadOverlay}>
          <Ionicons name="cloud-upload-outline" size={16} color="#fff" />
        </View>
      )}
      {showOverflow && !selectionMode && (
        <View style={styles.overflow}>
          <Text style={styles.overflowText}>+{overflowCount}</Text>
        </View>
      )}
      {selectionMode && (
        <View
          style={[
            styles.selectCheckbox,
            { borderColor: selected ? primaryColor : 'rgba(255,255,255,0.85)', backgroundColor: selected ? primaryColor : 'rgba(0,0,0,0.4)' },
          ]}
        >
          {selected && <Ionicons name="checkmark" size={14} color="#fff" />}
        </View>
      )}
    </TouchableOpacity>
  );
};

export const AlbumBubble = ({
  messages,
  showSenderInfo,
  senderName,
  isGroupChat,
  onMediaPress,
  onLongPress,
  onReactionsPress,
  onReplyPress,
  highlighted,
  dimmed,
  selectionMode,
  selectedIds,
  onToggleSelect,
}: AlbumBubbleProps) => {
  const { user } = useAuth();
  const { theme, isDark } = useTheme();

  const visible = useMemo(
    () =>
      messages.filter(
        (m) => !m.deletedForEveryone && !(user && m.deletedFor?.includes(user.userId)),
      ),
    [messages, user],
  );

  if (visible.length === 0) return null;

  // 4 tiles maximum; the last shows a "+N" overlay if there are more.
  const tiles = visible.slice(0, 4);
  const overflow = visible.length - tiles.length;
  const layout = useMemo(() => computeLayout(tiles.length), [tiles.length]);

  const anchor = visible[visible.length - 1];
  const isMine = user?.userId === anchor.senderId;
  const reply = visible[0]?.replyTo;

  // Show the first member's caption — keep the bubble compact instead of
  // stacking each item's caption (per-item captions still surface inside the
  // gallery viewer).
  const caption = useMemo(() => {
    for (const m of visible) {
      const c = (m.content ?? '').trim();
      if (!c) continue;
      // Drop the auto-placeholders we set when the user didn't type a caption.
      if (/^([\u{1F300}-\u{1FAFF}]|✨)\s*\w/u.test(c) && c.length < 24) continue;
      return c;
    }
    return '';
  }, [visible]);

  const bubbleBg = isMine ? theme.colors.primary : (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)');
  const captionColor = isMine ? '#fff' : theme.colors.onSurface;
  const timeColor = isMine ? 'rgba(255,255,255,0.7)' : theme.colors.onSurfaceVariant;

  return (
    <View style={[styles.row, isMine ? styles.rowMine : styles.rowTheirs]}>
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: bubbleBg,
            opacity: dimmed ? 0.4 : 1,
            borderColor: highlighted ? theme.colors.primary : 'transparent',
          },
        ]}
      >
        {showSenderInfo && !isMine && isGroupChat && senderName && (
          <Text style={[styles.senderName, { color: senderColor(anchor.senderId) }]}>
            {senderName}
          </Text>
        )}

        {reply && (
          <TouchableOpacity
            onPress={() => onReplyPress?.(reply.messageId)}
            activeOpacity={0.7}
            style={[
              styles.replyPreview,
              { borderLeftColor: senderColor(reply.senderId), backgroundColor: isMine ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.06)' },
            ]}
          >
            <Text style={[styles.replyName, { color: senderColor(reply.senderId) }]}>{reply.senderName}</Text>
            <Text numberOfLines={1} style={[styles.replyContent, { color: isMine ? 'rgba(255,255,255,0.85)' : theme.colors.onSurfaceVariant }]}>
              {reply.content}
            </Text>
          </TouchableOpacity>
        )}

        <View style={[styles.grid, { width: ALBUM_WIDTH }]}>
          {(() => {
            // In selection mode tap toggles selection; otherwise tap opens
            // the gallery viewer for the tapped cell. Album-wide reactions
            // are reached via long-press → action sheet (same path as
            // single messages); we don't try to double-tap-detect here
            // because doing so would force a 280ms delay on viewer open.
            const tapHandler = (m: ChatMessage) => {
              if (selectionMode) {
                onToggleSelect?.(m);
                return;
              }
              onMediaPress?.(m);
            };
            // Album actions are anchor-scoped — long-pressing any cell opens
            // the action sheet for the album as a whole. Per-cell delete /
            // forward live in the gallery (or bulk selection mode).
            const longHandler = (_m: ChatMessage) => onLongPress?.(anchor);
            const isSelected = (m: ChatMessage) => {
              if (!selectedIds) return false;
              return selectedIds.has(m.messageId) || selectedIds.has(m.id);
            };

            if (tiles.length === 3) {
              return (
                <>
                  <AlbumCell
                    message={tiles[0]}
                    style={layout[0]}
                    onPress={() => tapHandler(tiles[0])}
                    onLongPress={() => longHandler(tiles[0])}
                    showOverflow={false}
                    overflowCount={0}
                    selected={isSelected(tiles[0])}
                    selectionMode={selectionMode}
                    primaryColor={theme.colors.primary}
                  />
                  <View style={{ gap: GAP }}>
                    <AlbumCell
                      message={tiles[1]}
                      style={layout[1]}
                      onPress={() => tapHandler(tiles[1])}
                      onLongPress={() => longHandler(tiles[1])}
                      showOverflow={false}
                      overflowCount={0}
                      selected={isSelected(tiles[1])}
                      selectionMode={selectionMode}
                      primaryColor={theme.colors.primary}
                    />
                    <AlbumCell
                      message={tiles[2]}
                      style={layout[2]}
                      onPress={() => tapHandler(tiles[2])}
                      onLongPress={() => longHandler(tiles[2])}
                      showOverflow={false}
                      overflowCount={0}
                      selected={isSelected(tiles[2])}
                      selectionMode={selectionMode}
                      primaryColor={theme.colors.primary}
                    />
                  </View>
                </>
              );
            }
            return tiles.map((m, idx) => (
              <AlbumCell
                key={m.messageId || m.id}
                message={m}
                style={layout[idx]}
                onPress={() => tapHandler(m)}
                onLongPress={() => longHandler(m)}
                showOverflow={idx === tiles.length - 1 && overflow > 0}
                overflowCount={overflow}
                selected={isSelected(m)}
                selectionMode={selectionMode}
                primaryColor={theme.colors.primary}
              />
            ));
          })()}
        </View>

        {caption ? (
          <Text style={[styles.caption, { color: captionColor }]}>{caption}</Text>
        ) : null}

        <View style={styles.footer}>
          <Text style={[styles.time, { color: timeColor }]}>
            {formatRelativeTime(anchor.createdAt)}
          </Text>
          {isMine && (
            <Ionicons
              name={
                anchor.status === 'read'
                  ? 'checkmark-done'
                  : anchor.status === 'delivered'
                  ? 'checkmark-done-outline'
                  : anchor.status === 'sending'
                  ? 'time-outline'
                  : 'checkmark'
              }
              size={14}
              color={anchor.status === 'read' ? '#35C6FF' : 'rgba(255,255,255,0.7)'}
              style={{ marginLeft: 4 }}
            />
          )}
        </View>
      </View>
      {/* Reactions belong to the album as a whole — stored on the anchor and
          rendered just outside the bubble like a regular MessageBubble. */}
      <ReactionsRow
        reactions={anchor.reactions}
        currentUserId={user?.userId}
        align={isMine ? 'right' : 'left'}
        onPress={onReactionsPress ? () => onReactionsPress(anchor) : undefined}
      />
    </View>
  );
};

function computeLayout(count: number): ViewStyle[] {
  if (count <= 1) {
    return [{ width: ALBUM_WIDTH, height: Math.round(ALBUM_WIDTH * 0.75) }];
  }
  if (count === 2) {
    const cw = (ALBUM_WIDTH - GAP) / 2;
    return [
      { width: cw, height: cw },
      { width: cw, height: cw },
    ];
  }
  if (count === 3) {
    const small = (ALBUM_WIDTH - GAP) / 2;
    return [
      // Left big — full bubble height (= 2 small + gap)
      { width: small, height: small * 2 + GAP },
      // Right top
      { width: small, height: small },
      // Right bottom
      { width: small, height: small },
    ];
  }
  // 4 cells in a 2x2.
  const cw = (ALBUM_WIDTH - GAP) / 2;
  return Array.from({ length: 4 }, () => ({ width: cw, height: cw }));
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: 4,
    marginVertical: 2,
  },
  rowMine: {
    justifyContent: 'flex-end',
  },
  rowTheirs: {
    justifyContent: 'flex-start',
  },
  bubble: {
    padding: 4,
    borderRadius: 14,
    borderWidth: 1.5,
    overflow: 'hidden',
    maxWidth: ALBUM_WIDTH + 8,
  },
  senderName: {
    fontWeight: '700',
    fontSize: 13,
    paddingHorizontal: 6,
    paddingTop: 4,
    paddingBottom: 2,
  },
  replyPreview: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderLeftWidth: 3,
    borderRadius: 8,
    marginHorizontal: 4,
    marginBottom: 4,
  },
  replyName: {
    fontWeight: '700',
    fontSize: 12,
  },
  replyContent: {
    fontSize: 12,
  },
  grid: {
    flexDirection: 'row',
    gap: GAP,
    flexWrap: 'wrap',
    borderRadius: 10,
    overflow: 'hidden',
  },
  cell: {
    backgroundColor: '#1a1a1a',
    borderRadius: 6,
    overflow: 'hidden',
  },
  cellPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellSpinnerOverlay: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  playBadge: {
    position: 'absolute',
    alignSelf: 'center',
    top: '50%',
    marginTop: -16,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadOverlay: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  overflow: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectCheckbox: {
    position: 'absolute',
    top: 4,
    left: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overflowText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
  },
  caption: {
    paddingHorizontal: 8,
    paddingTop: 6,
    fontSize: 14,
    lineHeight: 18,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 4,
  },
  time: {
    fontSize: 11,
  },
});

export default AlbumBubble;
