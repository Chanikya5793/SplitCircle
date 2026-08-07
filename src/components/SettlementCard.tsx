import { GlassView } from '@/components/GlassView';
import { clearOpenSwipeable, setOpenSwipeable } from '@/utils/swipeableRegistry';
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
import { IconButton, Text, TouchableRipple } from 'react-native-paper';
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
    const { pressScaleStyle, touchableProps } = usePressFeedback();
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
                    onPress={() => {
                        errorHaptic();
                        swipeableRef.current?.close();
                        onDelete?.(settlement);
                    }}
                >
                    <View style={styles.deleteButtonPill}>
                        <IconButton icon="delete" iconColor="#fff" size={24} style={{ margin: 0 }} />
                        <Text style={styles.actionText}>Delete</Text>
                    </View>
                </RectButton>
            </RNAnimated.View>
        );
    };

    // See SwipeableExpenseCard — same list, same reasoning.
    return (
        <View
            style={
                isFlat
                    ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider }
                    : { marginBottom: 1 }
            }
        >
            <Swipeable
                ref={swipeableRef}
                onSwipeableWillOpen={() => setOpenSwipeable(swipeableRef.current)}
                onSwipeableClose={() => clearOpenSwipeable(swipeableRef.current)}
                renderRightActions={onDelete ? renderRightActions : undefined}
                friction={2}
                rightThreshold={40}
                overshootRight={false}
                containerStyle={{ borderRadius: 16, overflow: 'hidden' }}
            >
                <Animated.View style={pressScaleStyle}>
                <GlassView style={styles.container}>
                    <TouchableRipple onPress={handlePress} style={{ flex: 1 }} {...touchableProps}>
                        <View style={styles.content}>
                            <View style={styles.header}>
                                <View style={styles.titleRow}>
                                    <View style={styles.iconContainer}>
                                        <IconButton
                                            icon="handshake"
                                            size={20}
                                            iconColor={theme.colors.primary}
                                            style={styles.icon}
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
                        </View>
                    </TouchableRipple>
                </GlassView>
                </Animated.View>
            </Swipeable>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        // borderRadius handled by Swipeable containerStyle for clean clipping
        flex: 1,
    },
    content: {
        padding: 10, // Ultra-compact
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
    icon: {
        margin: 0,
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
        backgroundColor: '#ff6b6b',
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
        color: '#fff',
        fontSize: 13,
        fontWeight: 'bold',
        marginRight: 8,
    },
});
