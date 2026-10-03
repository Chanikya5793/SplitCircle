import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { IconButton, Text } from 'react-native-paper';
import { GlassCard, ScrimBackdrop, SelectableChip } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown, useSharedValue, useAnimatedStyle, withSpring, withTiming, runOnJS } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { ALL_EXPENSE_CATEGORIES } from '@/utils/categoryMatch';

export type SortField = 'date' | 'amount' | 'title';
export type SortOrder = 'desc' | 'asc';
export type ActivityTypeFilter = 'all' | 'expenses' | 'settlements';
export type DateRange = 'all' | 'this-month' | 'last-month' | 'last-3-months';

const CATEGORY_ICONS: Record<string, string> = {
    General: 'tag',
    Food: 'food',
    Transport: 'car',
    Utilities: 'flash',
    Entertainment: 'movie-open',
    Shopping: 'shopping',
    Travel: 'airplane',
    Health: 'hospital',
    Rent: 'home',
    Subscriptions: 'autorenew',
    Other: 'dots-horizontal',
};

// Derived from the canonical category list so every category an expense can
// carry (manual or recurring-bill-generated) is filterable. Ids stay
// lowercase — GroupDetailsScreen matches with exp.category.toLowerCase().
const CATEGORIES = [
    { id: 'all', label: 'All', icon: 'view-grid' },
    ...ALL_EXPENSE_CATEGORIES.map((category) => ({
        id: category.toLowerCase(),
        label: category,
        icon: CATEGORY_ICONS[category] ?? 'tag',
    })),
];

interface FilterSortSheetProps {
    visible: boolean;
    onClose: () => void;
    sortField: SortField;
    sortOrder: SortOrder;
    selectedCategories: string[];
    activityType: ActivityTypeFilter;
    dateRange: DateRange;
    onSortFieldChange: (field: SortField) => void;
    onSortOrderChange: (order: SortOrder) => void;
    onCategoryToggle: (category: string) => void;
    onActivityTypeChange: (type: ActivityTypeFilter) => void;
    onDateRangeChange: (range: DateRange) => void;
}

export const FilterSortSheet: React.FC<FilterSortSheetProps> = ({
    visible,
    onClose,
    sortField,
    sortOrder,
    selectedCategories,
    activityType,
    dateRange,
    onSortFieldChange,
    onSortOrderChange,
    onCategoryToggle,
    onActivityTypeChange,
    onDateRangeChange,
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
        <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
            <View style={styles.overlay}>
                <Pressable
                    style={styles.backdrop}
                    onPress={onClose}
                    accessibilityRole="button"
                    accessibilityLabel="Close filters"
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
                                    accessibilityLabel="Close filters"
                                />
                            </View>

                            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
                                {/* Sort by */}
                                <View style={styles.section}>
                                    <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
                                        Sort by
                                    </Text>
                                    <View style={styles.chipRow}>
                                        <SelectableChip label="Date" selected={sortField === 'date'} onPress={() => onSortFieldChange('date')} icon="calendar" />
                                        <SelectableChip label="Amount" selected={sortField === 'amount'} onPress={() => onSortFieldChange('amount')} icon="currency-usd" />
                                        <SelectableChip
                                            label="A-Z"
                                            selected={sortField === 'title'}
                                            onPress={() => onSortFieldChange('title')}
                                            icon="alphabetical"
                                            disabled={activityType === 'settlements'}
                                        />
                                    </View>
                                </View>

                                {/* Order */}
                                <View style={styles.section}>
                                    <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
                                        Order
                                    </Text>
                                    <View style={styles.chipRow}>
                                        <SelectableChip
                                            label={
                                                sortField === 'date' ? 'Newest first' :
                                                    sortField === 'amount' ? 'Highest first' :
                                                        'Z to A'
                                            }
                                            selected={sortOrder === 'desc'}
                                            onPress={() => onSortOrderChange('desc')}
                                            icon="arrow-down"
                                        />
                                        <SelectableChip
                                            label={
                                                sortField === 'date' ? 'Oldest first' :
                                                    sortField === 'amount' ? 'Lowest first' :
                                                        'A to Z'
                                            }
                                            selected={sortOrder === 'asc'}
                                            onPress={() => onSortOrderChange('asc')}
                                            icon="arrow-up"
                                        />
                                    </View>
                                </View>

                                {/* Timeframe */}
                                <View style={styles.section}>
                                    <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
                                        Timeframe
                                    </Text>
                                    <View style={styles.chipWrap}>
                                        <SelectableChip label="All Time" selected={dateRange === 'all'} onPress={() => onDateRangeChange('all')} />
                                        <SelectableChip label="This Month" selected={dateRange === 'this-month'} onPress={() => onDateRangeChange('this-month')} />
                                        <SelectableChip label="Last Month" selected={dateRange === 'last-month'} onPress={() => onDateRangeChange('last-month')} />
                                        <SelectableChip label="Last 3 Months" selected={dateRange === 'last-3-months'} onPress={() => onDateRangeChange('last-3-months')} />
                                    </View>
                                </View>

                                {/* Categories */}
                                <View style={[styles.section, activityType === 'settlements' && { opacity: 0.5 }]}>
                                    <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
                                        Categories
                                    </Text>
                                    <View style={styles.chipWrap} pointerEvents={activityType === 'settlements' ? 'none' : 'auto'}>
                                        {CATEGORIES.map((cat) => (
                                            <SelectableChip
                                                key={cat.id}
                                                label={cat.label}
                                                icon={cat.icon}
                                                selected={cat.id === 'all' ? selectedCategories.length === 0 : selectedCategories.includes(cat.id)}
                                                disabled={activityType === 'settlements'}
                                                onPress={() => onCategoryToggle(cat.id)}
                                            />
                                        ))}
                                    </View>
                                </View>

                                {/* Activity Type */}
                                <View style={styles.section}>
                                    <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
                                        Show
                                    </Text>
                                    <View style={styles.chipRow}>
                                        <SelectableChip label="All" selected={activityType === 'all'} onPress={() => onActivityTypeChange('all')} icon="view-list" />
                                        <SelectableChip label="Expenses" selected={activityType === 'expenses'} onPress={() => onActivityTypeChange('expenses')} icon="receipt" />
                                        <SelectableChip label="Settlements" selected={activityType === 'settlements'} onPress={() => onActivityTypeChange('settlements')} icon="handshake" />
                                    </View>
                                </View>
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
