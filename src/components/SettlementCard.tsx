import { GlassView } from '@/components/GlassView';
import { clearOpenSwipeable, setOpenSwipeable } from '@/utils/swipeableRegistry';
import { fullBleed } from '@/components/ui/layout';
import { ListSeparator } from '@/components/ui/ListSeparator';
import { SyncBadge } from '@/components/ui/SyncBadge';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { Settlement } from '@/models';
import { useMoneyDisplay } from '@/hooks/useMoneyDisplay';
import { usePrivacyMask } from '@/hooks/usePrivacyMask';
import { usePressFeedback } from '@/hooks/usePressFeedback';
import { errorHaptic, lightHaptic } from '@/utils/haptics';
import React, { useRef } from 'react';
import { Animated as RNAnimated, StyleSheet, View } from 'react-native';
import { RectButton, Swipeable } from 'react-native-gesture-handler';
import { Icon, Text, TouchableRipple } from 'react-native-paper';
import Animated from 'react-native-reanimated';

interface SettlementCardProps {
    settlement: Settlement;
    currency: string;
    memberMap: Record<string, string>;
    onPress: () => void;
    onDelete?: (settlement: Settlement) => void;
    index?: number;
    groupId?: string;
}

export const SettlementCard = ({
    settlement,
    currency,
    memberMap,
    onPress,
    onDelete,
    index = 0,
    groupId,
}: SettlementCardProps) => {
  const fmtMoney = useMoneyDisplay(groupId);
  const { maskGroupText } = usePrivacyMask();
    const { theme } = useTheme();
    const isFlat = theme?.surfaceStyle === 'flat';
    const { pressScaleStyle, pressHighlightStyle, touchableProps } = usePressFeedback();
    const { pendingSyncIds } = useGroups();
    const isPendingSync = pendingSyncIds.has(settlement.settlementId);
    const swipeableRef = useRef<Swipeable>(null);
    const fromName = maskGroupText(memberMap[settlement.fromUserId] || 'Unknown', groupId, 'person');
    const toName = maskGroupText(memberMap[settlement.toUserId] || 'Unknown', groupId, 'person');

    const handlePress = () => {
        lightHaptic();
        onPress();
    };

    const renderRightActions = (
        progress: RNAnimated.AnimatedInterpolation<number>,
        dragX: RNAnimated.AnimatedInterpolation<number>
    ) => {
        const translateX = dragX.interpolate({
            inputRange: [-120, 0],
            outputRange: [0, 120],
            extrapolate: 'clamp',
        });

        const scale = progress.interpolate({
            inputRange: [0, 1],
            outputRange: [0.8, 1],
            extrapolate: 'clamp',
        });

        return (
            <RNAnimated.View style={[styles.rightAction, { transform: [{ translateX }, { scale }] }]}>
                <RectButton
                    style={styles.rightActionPressable}
                    accessibilityRole="button"
                    accessibilityLabel="Delete settlement"
                    onPress={() => {
                        errorHaptic();
                        swipeableRef.current?.close();
                        onDelete?.(settlement);
                    }}
                >
                    <View style={[styles.deleteButtonPill, { backgroundColor: theme.colors.danger }]}>
                        <Icon source="delete" color={theme.colors.onDanger} size={24} />
                        <Text style={[styles.actionText, { color: theme.colors.onDanger }]}>Delete</Text>
                    </View>
                </RectButton>
            </RNAnimated.View>
        );
    };

    // See SwipeableExpenseCard — same list, same reasoning, including why the
    // hairline is a sibling element rather than a borderBottom.
    return (
        <View style={isFlat ? styles.bleed : styles.glassGap}>
            <Swipeable
                ref={swipeableRef}
                onSwipeableWillOpen={() => setOpenSwipeable(swipeableRef.current)}
                onSwipeableClose={() => clearOpenSwipeable(swipeableRef.current)}
                renderRightActions={onDelete ? renderRightActions : undefined}
                friction={2}
                rightThreshold={40}
                overshootRight={false}
                containerStyle={isFlat ? undefined : { borderRadius: 16, overflow: 'hidden' }}
            >
                <Animated.View style={pressScaleStyle}>
                <GlassView style={styles.container}>
                    <TouchableRipple
                        onPress={handlePress}
                        style={{ flex: 1 }}
                        accessibilityRole="button"
                        accessibilityLabel={`Settlement, ${fromName} to ${toName}, ${fmtMoney(settlement.amount, currency)}`}
                        accessibilityHint="Opens settlement details"
                        accessibilityActions={onDelete ? [{ name: 'delete', label: 'Delete settlement' }] : undefined}
                        onAccessibilityAction={({ nativeEvent: { actionName } }) => {
                            if (actionName === 'delete') onDelete?.(settlement);
                        }}
                        {...touchableProps}
                    >
                        <Animated.View style={[styles.content, isFlat && styles.contentFlat, pressHighlightStyle]}>
                            <View style={styles.header}>
                                <View style={styles.titleRow}>
                                    <View style={styles.iconContainer}>
                                        <Icon
                                            source="handshake"
                                            size={20}
                                            color={theme.colors.primary}
                                        />
                                    </View>
                                    <View style={{ flex: 1 }}>
                                        <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
                                            {maskGroupText('Settlement', groupId, 'note')}
                                        </Text>
                                        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                                            {fromName} → {toName}
                                        </Text>
                                        {settlement.note && (
                                            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                                                {maskGroupText(settlement.note, groupId, 'note')}
                                            </Text>
                                        )}
                                        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                                            {maskGroupText(new Date(settlement.createdAt).toLocaleDateString(), groupId)}
                                        </Text>
                                        {isPendingSync ? <SyncBadge style={{ marginTop: 4 }} /> : null}
                                    </View>
                                </View>
                                <View style={styles.amountContainer}>
                                    <Text variant="titleLarge" style={{ fontWeight: 'bold', color: theme.colors.primary }}>
                                        {fmtMoney(settlement.amount, currency)}
                                    </Text>
                                </View>
                            </View>
                        </Animated.View>
                    </TouchableRipple>
                </GlassView>
                </Animated.View>
            </Swipeable>
            <ListSeparator />
        </View>
    );
};

const styles = StyleSheet.create({
    /** See SwipeableExpenseCard.bleed. */
    bleed: {
        ...fullBleed,
    },
    glassGap: {
        marginBottom: 1,
    },
    container: {
        // borderRadius handled by Swipeable containerStyle for clean clipping
        flex: 1,
    },
    content: {
        padding: 10, // Ultra-compact
    },
    contentFlat: {
        paddingHorizontal: 16,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8, // Reduced gap
    },
    titleRow: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    iconContainer: {
        width: 40,
        height: 40,
        borderRadius: 20,
        justifyContent: 'center',
        alignItems: 'center',
    },
    amountContainer: {
        alignItems: 'flex-end',
    },
    rightAction: {
        width: 120, // ample space for the pill
        justifyContent: 'center',
        alignItems: 'center',
    },
    rightActionPressable: {
        flex: 1,
        width: '100%',
        justifyContent: 'center',
        alignItems: 'center',
    },
    deleteButtonPill: {
        width: 100,
        height: 56, // Horizontal pill shape
        borderRadius: 100,
        flexDirection: 'row', // Horizontal layout for icon + text
        justifyContent: 'center',
        alignItems: 'center',
        gap: 2,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 4,
        elevation: 3,
    },
    actionText: {
        fontSize: 13,
        fontWeight: 'bold',
        marginRight: 8,
    },
});
