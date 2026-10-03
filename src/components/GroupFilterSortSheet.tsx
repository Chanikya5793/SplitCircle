import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { IconButton, Text } from 'react-native-paper';
import { GlassCard, ScrimBackdrop, SelectableChip } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import Animated, {
    SlideInDown,
    useSharedValue,
    useAnimatedStyle,
    withTiming,
    withSpring,
    runOnJS
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

export type GroupSortField = 'name' | 'createdAt' | 'totalSpent' | 'updatedAt';
export type GroupSortOrder = 'asc' | 'desc';

interface GroupFilterSortSheetProps {
    visible: boolean;
    onClose: () => void;
    sortField: GroupSortField;
    sortOrder: GroupSortOrder;
    selectedCurrencies: string[];
    availableCurrencies: string[];
    onSortFieldChange: (field: GroupSortField) => void;
    onSortOrderChange: (order: GroupSortOrder) => void;
    onCurrencyToggle: (currency: string) => void;
}

export const GroupFilterSortSheet: React.FC<GroupFilterSortSheetProps> = ({
    visible,
    onClose,
    sortField,
    sortOrder,
    selectedCurrencies,
    availableCurrencies,
    onSortFieldChange,
    onSortOrderChange,
    onCurrencyToggle,
}) => {
    const { theme, isDark } = useTheme();
    const translateY = useSharedValue(0);
    const context = useSharedValue({ y: 0 });

    const gesture = Gesture.Pan()
        .onStart(() => {
            context.value = { y: translateY.value };
        })
        .onUpdate((event) => {
            translateY.value = Math.max(0, event.translationY + context.value.y);
        })
        .onEnd((event) => {
            if (translateY.value > 100 || event.velocityY > 500) {
                translateY.value = withTiming(1000, { duration: 200 }, () => {
                    runOnJS(onClose)();
                });
            } else {
                translateY.value = withSpring(0, { damping: 50 });
            }
        });

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: translateY.value }],
    }));

    // Reset translation when visible becomes true
    React.useEffect(() => {
        if (visible) {
            translateY.value = 0;
        }
    }, [visible]);

    if (!visible) return null;

    return (
        <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
            <View style={styles.overlay}>
                <Pressable
                    style={styles.backdrop}
                    onPress={onClose}
                    accessibilityRole="button"
                    accessibilityLabel="Close group filters"
                >
                    <ScrimBackdrop pointerEvents="none" />
                </Pressable>

                <GestureDetector gesture={gesture}>
                    <Animated.View
                        entering={SlideInDown.springify().damping(30).stiffness(350).mass(1)}
                        style={[styles.sheetContainer, animatedStyle]}
                    >
                        <GlassCard role="floating" style={styles.sheetGlass} contentStyle={styles.sheet} intensity={80}>
                            {/* Handle bar */}
                            <View style={styles.handleContainer}>
                                <View style={[styles.handle, { backgroundColor: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.2)' }]} />
                            </View>

                            {/* Header */}
                            <View style={styles.header}>
                                <Text variant="titleLarge" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
                                    Filters
                                </Text>
                                <IconButton
                                    icon="close"
                                    size={22}
                                    onPress={onClose}
                                    iconColor={theme.colors.onSurfaceVariant}
                                    accessibilityLabel="Close group filters"
                                />
                            </View>

                            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
                                {/* Sort by */}
                                <View style={styles.section}>
                                    <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
                                        Sort by
                                    </Text>
                                    <View style={styles.chipWrap}>
                                        <SelectableChip label="Activity" selected={sortField === 'updatedAt'} onPress={() => onSortFieldChange('updatedAt')} icon="clock-outline" />
                                        <SelectableChip label="Name" selected={sortField === 'name'} onPress={() => onSortFieldChange('name')} icon="alphabetical" />
                                        <SelectableChip label="Created" selected={sortField === 'createdAt'} onPress={() => onSortFieldChange('createdAt')} icon="calendar" />
                                        <SelectableChip label="Total Spent" selected={sortField === 'totalSpent'} onPress={() => onSortFieldChange('totalSpent')} icon="currency-usd" />
                                    </View>
                                </View>

                                {/* Order */}
                                <View style={styles.section}>
                                    <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
                                        Order
                                    </Text>
                                    <View style={styles.chipWrap}>
                                        <SelectableChip
                                            label={
                                                (sortField === 'createdAt' || sortField === 'updatedAt') ? 'Newest first' :
                                                    sortField === 'totalSpent' ? 'Highest first' :
                                                        'Z to A'
                                            }
                                            selected={sortOrder === 'desc'}
                                            onPress={() => onSortOrderChange('desc')}
                                            icon="arrow-down"
                                        />
                                        <SelectableChip
                                            label={
                                                (sortField === 'createdAt' || sortField === 'updatedAt') ? 'Oldest first' :
                                                    sortField === 'totalSpent' ? 'Lowest first' :
                                                        'A to Z'
                                            }
                                            selected={sortOrder === 'asc'}
                                            onPress={() => onSortOrderChange('asc')}
                                            icon="arrow-up"
                                        />
                                    </View>
                                </View>

                                {/* Currencies */}
                                {availableCurrencies.length > 0 && (
                                    <View style={styles.section}>
                                        <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
                                            Currencies
                                        </Text>
                                        <View style={styles.chipWrap}>
                                            {availableCurrencies.map(currency => (
                                                <SelectableChip
                                                    key={currency}
                                                    label={currency}
                                                    selected={selectedCurrencies.includes(currency)}
                                                    onPress={() => onCurrencyToggle(currency)}
                                                />
                                            ))}
                                        </View>
                                    </View>
                                )}
                            </ScrollView>
                        </GlassCard>
                    </Animated.View>
                </GestureDetector>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
    },
    sheetContainer: {
        maxHeight: '70%',
    },
    sheetGlass: {
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
    },
    sheet: {
        paddingBottom: 40,
    },
    handleContainer: {
        alignItems: 'center',
        paddingTop: 12,
        paddingBottom: 4,
    },
    handle: {
        width: 40,
        height: 4,
        borderRadius: 2,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingBottom: 8,
    },
    content: {
        paddingHorizontal: 20,
        paddingBottom: 80,
    },
    section: {
        marginBottom: 20,
    },
    sectionTitle: {
        marginBottom: 10,
        fontWeight: '600',
    },
    chipRow: {
        flexDirection: 'row',
        gap: 10,
    },
    chipWrap: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
    },
});
