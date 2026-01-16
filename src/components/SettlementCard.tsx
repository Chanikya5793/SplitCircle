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
            inputRange: [-80, 0],
            outputRange: [0, 80],
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
                    style={[styles.deleteButton, { backgroundColor: theme.colors.error }]}
                    onPress={() => {
                        errorHaptic();
                        swipeableRef.current?.close();
                        onDelete?.(settlement);
                    }}
                >
                    <IconButton icon="delete" iconColor="#fff" size={24} />
                    <Text style={styles.actionText}>Delete</Text>
                </RectButton>
            </RNAnimated.View>
        );
    };

    return (
        <Animated.View entering={FadeInDown.delay(index * 50).springify()}>
            <Swipeable
                ref={swipeableRef}
                renderRightActions={onDelete ? renderRightActions : undefined}
                friction={2}
                rightThreshold={40}
                overshootRight={false}
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
        borderRadius: 24,
        marginBottom: 12,
        overflow: 'hidden',
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
        width: 80,
        justifyContent: 'center',
        alignItems: 'center',
    },
    deleteButton: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        width: 80,
    },
    actionText: {
        color: '#fff',
        fontSize: 12,
        fontWeight: '600',
    },
});
