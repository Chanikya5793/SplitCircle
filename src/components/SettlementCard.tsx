import { GlassView } from '@/components/GlassView';
import { useTheme } from '@/context/ThemeContext';
import type { Settlement } from '@/models';
import { formatCurrency } from '@/utils/currency';
import { errorHaptic, lightHaptic } from '@/utils/haptics';
import React, { useRef } from 'react';
import { Animated as RNAnimated, StyleSheet, View } from 'react-native';
import { RectButton, Swipeable } from 'react-native-gesture-handler';
import { IconButton, Text, TouchableRipple } from 'react-native-paper';
import Animated, { FadeInDown } from 'react-native-reanimated';

interface SettlementCardProps {
    settlement: Settlement;
    currency: string;
    memberMap: Record<string, string>;
    onPress: () => void;
    onDelete?: (settlement: Settlement) => void;
    index?: number;
}

export const SettlementCard = ({
    settlement,
    currency,
    memberMap,
    onPress,
    onDelete,
    index = 0,
}: SettlementCardProps) => {
    const { theme } = useTheme();
    const swipeableRef = useRef<Swipeable>(null);
    const fromName = memberMap[settlement.fromUserId] || 'Unknown';
    const toName = memberMap[settlement.toUserId] || 'Unknown';

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

    return (
        <Animated.View entering={FadeInDown.delay(index * 50).springify()} style={{ marginBottom: 12 }}>
            <Swipeable
                ref={swipeableRef}
                renderRightActions={onDelete ? renderRightActions : undefined}
                friction={2}
                rightThreshold={40}
                overshootRight={false}
                containerStyle={{ borderRadius: 24, overflow: 'hidden' }}
            >
                <GlassView style={styles.container}>
                    <TouchableRipple onPress={handlePress} style={{ flex: 1 }}>
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
                                            Settlement
                                        </Text>
                                        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                                            {fromName} → {toName}
                                        </Text>
                                        {settlement.note && (
                                            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                                                {settlement.note}
                                            </Text>
                                        )}
                                        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                                            {new Date(settlement.createdAt).toLocaleDateString()}
                                        </Text>
                                    </View>
                                </View>
                                <View style={styles.amountContainer}>
                                    <Text variant="titleLarge" style={{ fontWeight: 'bold', color: theme.colors.primary }}>
                                        {formatCurrency(settlement.amount, currency)}
                                    </Text>
                                    <IconButton icon="check-circle" size={20} iconColor={theme.colors.primary} />
                                </View>
                            </View>
                        </View>
                    </TouchableRipple>
                </GlassView>
            </Swipeable>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    container: {
        // borderRadius handled by Swipeable containerStyle for clean clipping
        flex: 1,
    },
    content: {
        padding: 16,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
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
