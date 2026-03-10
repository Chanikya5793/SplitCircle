import type { RecurrenceRule } from '@/models/recurringBill';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const MAX_SEARCH_DAYS = 3650; // 10 years

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const normalizeNumberArray = (values: number[] | undefined, min: number, max: number): number[] => {
    if (!values?.length) return [];
    const unique = new Set<number>();
    values.forEach((value) => {
        const normalized = Math.trunc(value);
        if (Number.isFinite(normalized) && normalized >= min && normalized <= max) {
            unique.add(normalized);
        }
    });
    return Array.from(unique).sort((a, b) => a - b);
};

const getWeekOfMonth = (dayOfMonth: number): number => {
    return Math.floor((dayOfMonth - 1) / 7) + 1;
};

const getTimezoneOffsetMinutes = (rule: Partial<RecurrenceRule> | undefined): number => {
    const offset = rule?.timezoneOffsetMinutes;
    if (typeof offset === 'number' && Number.isFinite(offset)) {
        return Math.trunc(offset);
    }
    return -new Date().getTimezoneOffset();
};

const toLocalDate = (timestamp: number, offsetMinutes: number): Date => {
    return new Date(timestamp + (offsetMinutes * ONE_MINUTE_MS));
};

const getStartLocalDate = (startAt: number, offsetMinutes: number): Date => {
    return toLocalDate(startAt, offsetMinutes);
};

const getStartOfWeekLocal = (date: Date): Date => {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay()));
};

const getWeeksSinceStart = (startLocal: Date, currentLocal: Date): number => {
    const startWeek = getStartOfWeekLocal(startLocal);
    const currentWeek = getStartOfWeekLocal(currentLocal);
    return Math.floor((currentWeek.getTime() - startWeek.getTime()) / (7 * ONE_DAY_MS));
};

const getMonthsSinceStart = (startLocal: Date, currentLocal: Date): number => {
    return ((currentLocal.getUTCFullYear() - startLocal.getUTCFullYear()) * 12) +
        (currentLocal.getUTCMonth() - startLocal.getUTCMonth());
};

const doesDayMatchPattern = (
    currentLocal: Date,
    rule: RecurrenceRule,
): boolean => {
    if (rule.monthlyPattern === 'weekdaysOfMonth') {
        const weeks = normalizeNumberArray(rule.weeksOfMonth, 1, 5);
        const weekdays = normalizeNumberArray(rule.weekdays, 0, 6);
        if (!weeks.length || !weekdays.length) return false;
        return weeks.includes(getWeekOfMonth(currentLocal.getUTCDate())) && weekdays.includes(currentLocal.getUTCDay());
    }

    const daysOfMonth = normalizeNumberArray(rule.daysOfMonth, 1, 31);
    if (!daysOfMonth.length) return false;
    return daysOfMonth.includes(currentLocal.getUTCDate());
};

export const normalizeRecurrenceRule = (
    rule: Partial<RecurrenceRule> | undefined,
    startAt: number,
): RecurrenceRule => {
    const timezoneOffsetMinutes = getTimezoneOffsetMinutes(rule);
    const startLocal = toLocalDate(startAt, timezoneOffsetMinutes);
    const inferredMonthDay = startLocal.getUTCDate();
    const inferredWeekday = startLocal.getUTCDay();
    const inferredWeekOfMonth = getWeekOfMonth(inferredMonthDay);
    const inferredMonth = startLocal.getUTCMonth() + 1;

    const frequency = rule?.frequency ?? 'monthly';
    const interval = Math.max(1, Math.trunc(rule?.interval ?? 1));
    const monthlyPattern = rule?.monthlyPattern
        ?? ((rule?.weeksOfMonth?.length || rule?.weekdays?.length) ? 'weekdaysOfMonth' : 'dayOfMonth');

    const weekdays = normalizeNumberArray(rule?.weekdays, 0, 6);
    const daysOfMonth = normalizeNumberArray(rule?.daysOfMonth, 1, 31);
    const weeksOfMonth = normalizeNumberArray(rule?.weeksOfMonth, 1, 5);
    const monthsOfYear = normalizeNumberArray(rule?.monthsOfYear, 1, 12);

    const normalizedWeekdays = weekdays.length ? weekdays : [inferredWeekday];
    const normalizedDaysOfMonth = daysOfMonth.length ? daysOfMonth : [inferredMonthDay];
    const normalizedWeeksOfMonth = weeksOfMonth.length ? weeksOfMonth : [inferredWeekOfMonth];
    const normalizedMonths = monthsOfYear.length
        ? monthsOfYear
        : (frequency === 'yearly' ? [inferredMonth] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    if (frequency === 'daily') {
        return {
            frequency,
            interval,
            timezoneOffsetMinutes,
        };
    }

    if (frequency === 'weekly') {
        return {
            frequency,
            interval,
            weekdays: normalizedWeekdays,
            timezoneOffsetMinutes,
        };
    }

    return {
        frequency,
        interval,
        monthlyPattern,
        weekdays: normalizedWeekdays,
        daysOfMonth: normalizedDaysOfMonth,
        weeksOfMonth: normalizedWeeksOfMonth,
        monthsOfYear: normalizedMonths,
        timezoneOffsetMinutes,
    };
};

export const doesTimestampMatchRecurrence = (
    timestamp: number,
    rule: RecurrenceRule,
    startAt: number,
): boolean => {
    const normalizedRule = normalizeRecurrenceRule(rule, startAt);
    const offsetMinutes = normalizedRule.timezoneOffsetMinutes ?? 0;
    const currentLocal = toLocalDate(timestamp, offsetMinutes);
    const startLocal = getStartLocalDate(startAt, offsetMinutes);

    if (timestamp < startAt) return false;

    if (normalizedRule.frequency === 'daily') {
        const daysDiff = Math.round((currentLocal.getTime() - startLocal.getTime()) / ONE_DAY_MS);
        return daysDiff >= 0 && daysDiff % normalizedRule.interval === 0;
    }

    if (normalizedRule.frequency === 'weekly') {
        const weekdays = normalizedRule.weekdays ?? [];
        if (!weekdays.includes(currentLocal.getUTCDay())) return false;
        const weeksSinceStart = getWeeksSinceStart(startLocal, currentLocal);
        return weeksSinceStart >= 0 && weeksSinceStart % normalizedRule.interval === 0;
    }

    const monthsOfYear = normalizedRule.monthsOfYear ?? [];
    if (monthsOfYear.length && !monthsOfYear.includes(currentLocal.getUTCMonth() + 1)) {
        return false;
    }

    if (normalizedRule.frequency === 'monthly') {
        const monthsSinceStart = getMonthsSinceStart(startLocal, currentLocal);
        if (monthsSinceStart < 0 || monthsSinceStart % normalizedRule.interval !== 0) {
            return false;
        }
        return doesDayMatchPattern(currentLocal, normalizedRule);
    }

    const yearsSinceStart = currentLocal.getUTCFullYear() - startLocal.getUTCFullYear();
    if (yearsSinceStart < 0 || yearsSinceStart % normalizedRule.interval !== 0) {
        return false;
    }
    return doesDayMatchPattern(currentLocal, normalizedRule);
};

export const findNextOccurrenceAt = (
    rule: RecurrenceRule,
    startAt: number,
    afterTimestamp: number,
): number | null => {
    const normalizedRule = normalizeRecurrenceRule(rule, startAt);
    const offsetMinutes = normalizedRule.timezoneOffsetMinutes ?? 0;
    const startLocal = getStartLocalDate(startAt, offsetMinutes);

    const searchFrom = Math.max(startAt, afterTimestamp + 1);
    const searchStartLocal = toLocalDate(searchFrom, offsetMinutes);

    const scheduledHour = startLocal.getUTCHours();
    const scheduledMinute = startLocal.getUTCMinutes();
    const scheduledSecond = startLocal.getUTCSeconds();
    const scheduledMillisecond = startLocal.getUTCMilliseconds();

    for (let dayOffset = 0; dayOffset <= MAX_SEARCH_DAYS; dayOffset++) {
        const localCandidate = new Date(Date.UTC(
            searchStartLocal.getUTCFullYear(),
            searchStartLocal.getUTCMonth(),
            searchStartLocal.getUTCDate() + dayOffset,
            scheduledHour,
            scheduledMinute,
            scheduledSecond,
            scheduledMillisecond,
        ));
        const candidateUtc = localCandidate.getTime() - (offsetMinutes * ONE_MINUTE_MS);
        if (candidateUtc < searchFrom) continue;
        if (doesTimestampMatchRecurrence(candidateUtc, normalizedRule, startAt)) {
            return candidateUtc;
        }
    }

    return null;
};

export const getNextDueAt = (
    rule: RecurrenceRule,
    startAt: number,
    currentDueAt: number,
): number | null => {
    return findNextOccurrenceAt(rule, startAt, currentDueAt);
};

export const getRecurrenceSummary = (rule: RecurrenceRule): string => {
    const normalizedRule = normalizeRecurrenceRule(rule, Date.now());

    if (normalizedRule.frequency === 'daily') {
        if (normalizedRule.interval === 1) return 'Every day';
        if (normalizedRule.interval === 2) return 'Every other day';
        return `Every ${normalizedRule.interval} days`;
    }

    if (normalizedRule.frequency === 'weekly') {
        const weekdays = normalizedRule.weekdays ?? [];
        const weekdayNames = weekdays.map((day) => WEEKDAY_LABELS[day]).join(', ');

        // Friendly labels for well-known patterns
        if (normalizedRule.interval === 1 && weekdays.length === 5 && [1, 2, 3, 4, 5].every((d) => weekdays.includes(d))) {
            return 'Weekdays (Mon–Fri)';
        }
        if (normalizedRule.interval === 1 && weekdays.length === 2 && weekdays.includes(0) && weekdays.includes(6)) {
            return 'Weekends (Sat–Sun)';
        }

        if (normalizedRule.interval === 1) return `Every week on ${weekdayNames}`;
        if (normalizedRule.interval === 2) return `Every 2 weeks on ${weekdayNames}`;
        if (normalizedRule.interval === 3) return `Every 3 weeks on ${weekdayNames}`;
        return `Every ${normalizedRule.interval} weeks on ${weekdayNames}`;
    }

    const months = normalizedRule.monthsOfYear ?? [];
    const monthsText = months.length && months.length < 12
        ? ` in ${months.map((month) => MONTH_LABELS[month - 1]).join(', ')}`
        : '';

    if (normalizedRule.frequency === 'monthly') {
        const intervalLabel =
            normalizedRule.interval === 1 ? 'Monthly'
            : normalizedRule.interval === 2 ? 'Every 2 months (bi-monthly)'
            : normalizedRule.interval === 3 ? 'Quarterly (every 3 months)'
            : normalizedRule.interval === 4 ? 'Every 4 months'
            : normalizedRule.interval === 6 ? 'Every 6 months (semi-annual)'
            : `Every ${normalizedRule.interval} months`;

        if (normalizedRule.monthlyPattern === 'weekdaysOfMonth') {
            const weeks = (normalizedRule.weeksOfMonth ?? []).map((w) => `week ${w}`).join(', ');
            const weekdays = (normalizedRule.weekdays ?? []).map((day) => WEEKDAY_LABELS[day]).join(', ');
            return `${intervalLabel} on ${weeks} (${weekdays})${monthsText}`;
        }

        const days = normalizedRule.daysOfMonth ?? [];
        if (days.length === 2 && days.includes(1) && days.includes(15)) {
            return `Twice a month (1st & 15th)${monthsText}`;
        }
        const dayNames = days.map((d) => ordinal(d)).join(', ');
        return `${intervalLabel} on the ${dayNames}${monthsText}`;
    }

    // yearly
    const yearLabel = normalizedRule.interval === 1 ? 'Yearly (every 1 year)'
        : normalizedRule.interval === 2 ? 'Every 2 years (biannual cycle)'
        : `Every ${normalizedRule.interval} years`;

    if (normalizedRule.monthlyPattern === 'weekdaysOfMonth') {
        const weeks = (normalizedRule.weeksOfMonth ?? []).map((w) => `week ${w}`).join(', ');
        const weekdays = (normalizedRule.weekdays ?? []).map((day) => WEEKDAY_LABELS[day]).join(', ');
        return `${yearLabel} on ${weeks} (${weekdays})${monthsText}`;
    }

    const days = (normalizedRule.daysOfMonth ?? []).map((d) => ordinal(d)).join(', ');
    return `${yearLabel} on the ${days}${monthsText}`;
};

const ordinal = (n: number): string => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
