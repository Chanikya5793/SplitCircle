import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { IconButton, Text } from 'react-native-paper';
import { BlurView } from 'expo-blur';
import { useTheme } from '@/context/ThemeContext';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';

export type SortField = 'date' | 'amount' | 'title';
export type SortOrder = 'desc' | 'asc';
export type ActivityTypeFilter = 'all' | 'expenses' | 'settlements';
export type DateRange = 'all' | 'this-month' | 'last-month' | 'last-3-months';

const CATEGORIES = [
    { id: 'all', label: 'All', icon: 'view-grid' },
    { id: 'food', label: 'Food', icon: 'food' },
    { id: 'transport', label: 'Transport', icon: 'car' },
    { id: 'entertainment', label: 'Entertainment', icon: 'movie-open' },
    { id: 'shopping', label: 'Shopping', icon: 'shopping' },
    { id: 'utilities', label: 'Utilities', icon: 'flash' },
    { id: 'rent', label: 'Rent', icon: 'home' },
    { id: 'travel', label: 'Travel', icon: 'airplane' },
    { id: 'health', label: 'Health', icon: 'hospital' },
    { id: 'other', label: 'Other', icon: 'dots-horizontal' },
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

    const Chip = ({
        label,
        selected,
        onPress,
        icon,
        disabled = false
    }: {
        label: string;
        selected: boolean;
        onPress: () => void;
        icon?: string;
        disabled?: boolean;
    }) => (
        <Pressable
            onPress={disabled ? undefined : onPress}
            style={[
                styles.chip,
                {
                    backgroundColor: selected
                        ? theme.colors.primary
                        : isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
                    borderColor: selected ? theme.colors.primary : 'transparent',
                    opacity: disabled ? 0.4 : 1,
                },
            ]}
        >
            {icon && (
                <IconButton
                    icon={icon}
                    size={16}
                    iconColor={selected ? '#fff' : theme.colors.onSurface}
                    style={{ margin: 0, marginRight: -4 }}
                />
            )}
            <Text
                variant="labelMedium"
                style={{
                    color: selected ? '#fff' : theme.colors.onSurface,
                    fontWeight: selected ? '600' : '500',
                }}
            >
                {label}
            </Text>
        </Pressable>
    );

    if (!visible) return null;

    return (
        <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
            <View style={styles.overlay}>
                <Pressable style={styles.backdrop} onPress={onClose} />

                <Animated.View entering={SlideInDown.springify().damping(30).stiffness(350).mass(1)} style={styles.sheetContainer}>
                    <BlurView
                        intensity={80}
                        tint={isDark ? 'dark' : 'light'}
                        style={StyleSheet.absoluteFill}
                    />
                    <View style={[styles.sheet, { backgroundColor: isDark ? 'rgba(30,30,40,0.35)' : 'rgba(255,255,255,0.4)' }]}>
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
                            />
                        </View>

                        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
                            {/* Sort by */}
                            <View style={styles.section}>
                                <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
                                    Sort by
                                </Text>
                                <View style={styles.chipRow}>
                                    <Chip label="Date" selected={sortField === 'date'} onPress={() => onSortFieldChange('date')} icon="calendar" />
                                    <Chip label="Amount" selected={sortField === 'amount'} onPress={() => onSortFieldChange('amount')} icon="currency-usd" />
                                    <Chip
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
                                    <Chip
                                        label={
                                            sortField === 'date' ? 'Newest first' :
                                                sortField === 'amount' ? 'Highest first' :
                                                    'Z to A'
                                        }
                                        selected={sortOrder === 'desc'}
                                        onPress={() => onSortOrderChange('desc')}
                                        icon="arrow-down"
                                    />
                                    <Chip
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
                                    <Chip label="All Time" selected={dateRange === 'all'} onPress={() => onDateRangeChange('all')} />
                                    <Chip label="This Month" selected={dateRange === 'this-month'} onPress={() => onDateRangeChange('this-month')} />
                                    <Chip label="Last Month" selected={dateRange === 'last-month'} onPress={() => onDateRangeChange('last-month')} />
                                    <Chip label="Last 3 Months" selected={dateRange === 'last-3-months'} onPress={() => onDateRangeChange('last-3-months')} />
                                </View>
                            </View>

                            {/* Categories */}
                            <View style={[styles.section, activityType === 'settlements' && { opacity: 0.5 }]}>
                                <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
                                    Categories
                                </Text>
                                <View style={styles.chipWrap} pointerEvents={activityType === 'settlements' ? 'none' : 'auto'}>
                                    {CATEGORIES.map((cat) => (
                                        <Chip
                                            key={cat.id}
                                            label={cat.label}
                                            icon={cat.icon}
                                            selected={cat.id === 'all' ? selectedCategories.length === 0 : selectedCategories.includes(cat.id)}
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
                                    <Chip label="All" selected={activityType === 'all'} onPress={() => onActivityTypeChange('all')} icon="view-list" />
                                    <Chip label="Expenses" selected={activityType === 'expenses'} onPress={() => onActivityTypeChange('expenses')} icon="receipt" />
                                    <Chip label="Settlements" selected={activityType === 'settlements'} onPress={() => onActivityTypeChange('settlements')} icon="handshake" />
                                </View>
                            </View>
                        </ScrollView>
                    </View>
                </Animated.View>
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
        backgroundColor: 'rgba(0,0,0,0.4)',
    },
    sheetContainer: {
        maxHeight: '70%',
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.15)',
        borderBottomWidth: 0,
    },
    blurView: {
        flex: 1,
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
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 50,
        borderWidth: 1,
    },
});
