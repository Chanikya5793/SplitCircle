"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findNextOccurrenceAt = exports.doesTimestampMatchRecurrence = exports.toLegacyRecurrenceRule = exports.normalizeRecurrenceRule = void 0;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const MAX_SEARCH_DAYS = 3650; // 10 years
const normalizeNumberArray = (values, min, max) => {
    if (!(values === null || values === void 0 ? void 0 : values.length))
        return [];
    const unique = new Set();
    values.forEach((value) => {
        const normalized = Math.trunc(value);
        if (Number.isFinite(normalized) && normalized >= min && normalized <= max) {
            unique.add(normalized);
        }
    });
    return Array.from(unique).sort((a, b) => a - b);
};
const getWeekOfMonth = (dayOfMonth) => {
    return Math.floor((dayOfMonth - 1) / 7) + 1;
};
const toLocalDate = (timestamp, offsetMinutes) => {
    return new Date(timestamp + (offsetMinutes * ONE_MINUTE_MS));
};
const getStartOfWeekLocal = (date) => {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay()));
};
const getWeeksSinceStart = (startLocal, currentLocal) => {
    const startWeek = getStartOfWeekLocal(startLocal);
    const currentWeek = getStartOfWeekLocal(currentLocal);
    return Math.floor((currentWeek.getTime() - startWeek.getTime()) / (7 * ONE_DAY_MS));
};
const getMonthsSinceStart = (startLocal, currentLocal) => {
    return ((currentLocal.getUTCFullYear() - startLocal.getUTCFullYear()) * 12) +
        (currentLocal.getUTCMonth() - startLocal.getUTCMonth());
};
const doesDayMatchPattern = (currentLocal, rule) => {
    if (rule.monthlyPattern === "weekdaysOfMonth") {
        const weeks = normalizeNumberArray(rule.weeksOfMonth, 1, 5);
        const weekdays = normalizeNumberArray(rule.weekdays, 0, 6);
        if (!weeks.length || !weekdays.length)
            return false;
        return weeks.includes(getWeekOfMonth(currentLocal.getUTCDate())) && weekdays.includes(currentLocal.getUTCDay());
    }
    const daysOfMonth = normalizeNumberArray(rule.daysOfMonth, 1, 31);
    if (!daysOfMonth.length)
        return false;
    return daysOfMonth.includes(currentLocal.getUTCDate());
};
const normalizeRecurrenceRule = (rule, startAt) => {
    var _a, _b, _c, _d, _e;
    const timezoneOffsetMinutes = typeof (rule === null || rule === void 0 ? void 0 : rule.timezoneOffsetMinutes) === "number" && Number.isFinite(rule.timezoneOffsetMinutes)
        ? Math.trunc(rule.timezoneOffsetMinutes)
        : 0;
    const startLocal = toLocalDate(startAt, timezoneOffsetMinutes);
    const inferredMonthDay = startLocal.getUTCDate();
    const inferredWeekday = startLocal.getUTCDay();
    const inferredWeekOfMonth = getWeekOfMonth(inferredMonthDay);
    const inferredMonth = startLocal.getUTCMonth() + 1;
    const frequency = (_a = rule === null || rule === void 0 ? void 0 : rule.frequency) !== null && _a !== void 0 ? _a : "monthly";
    const interval = Math.max(1, Math.trunc((_b = rule === null || rule === void 0 ? void 0 : rule.interval) !== null && _b !== void 0 ? _b : 1));
    const monthlyPattern = (_c = rule === null || rule === void 0 ? void 0 : rule.monthlyPattern) !== null && _c !== void 0 ? _c : ((((_d = rule === null || rule === void 0 ? void 0 : rule.weeksOfMonth) === null || _d === void 0 ? void 0 : _d.length) || ((_e = rule === null || rule === void 0 ? void 0 : rule.weekdays) === null || _e === void 0 ? void 0 : _e.length)) ? "weekdaysOfMonth" : "dayOfMonth");
    const weekdays = normalizeNumberArray(rule === null || rule === void 0 ? void 0 : rule.weekdays, 0, 6);
    const daysOfMonth = normalizeNumberArray(rule === null || rule === void 0 ? void 0 : rule.daysOfMonth, 1, 31);
    const weeksOfMonth = normalizeNumberArray(rule === null || rule === void 0 ? void 0 : rule.weeksOfMonth, 1, 5);
    const monthsOfYear = normalizeNumberArray(rule === null || rule === void 0 ? void 0 : rule.monthsOfYear, 1, 12);
    const normalizedWeekdays = weekdays.length ? weekdays : [inferredWeekday];
    const normalizedDaysOfMonth = daysOfMonth.length ? daysOfMonth : [inferredMonthDay];
    const normalizedWeeksOfMonth = weeksOfMonth.length ? weeksOfMonth : [inferredWeekOfMonth];
    const normalizedMonths = monthsOfYear.length
        ? monthsOfYear
        : (frequency === "yearly" ? [inferredMonth] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    if (frequency === "daily") {
        return {
            frequency,
            interval,
            timezoneOffsetMinutes,
        };
    }
    if (frequency === "weekly") {
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
exports.normalizeRecurrenceRule = normalizeRecurrenceRule;
const toLegacyRecurrenceRule = (frequency, dayOfWeek, dayOfMonth, startAt) => {
    const fallbackDayOfWeek = typeof dayOfWeek === "number" ? dayOfWeek : new Date(startAt).getDay();
    const fallbackDayOfMonth = typeof dayOfMonth === "number" ? dayOfMonth : new Date(startAt).getDate();
    switch (frequency) {
        case "biweekly":
            return (0, exports.normalizeRecurrenceRule)({
                frequency: "weekly",
                interval: 2,
                weekdays: [fallbackDayOfWeek],
                timezoneOffsetMinutes: 0,
            }, startAt);
        case "weekly":
            return (0, exports.normalizeRecurrenceRule)({
                frequency: "weekly",
                interval: 1,
                weekdays: [fallbackDayOfWeek],
                timezoneOffsetMinutes: 0,
            }, startAt);
        case "monthly":
        default:
            return (0, exports.normalizeRecurrenceRule)({
                frequency: "monthly",
                interval: 1,
                monthlyPattern: "dayOfMonth",
                daysOfMonth: [fallbackDayOfMonth],
                timezoneOffsetMinutes: 0,
            }, startAt);
    }
};
exports.toLegacyRecurrenceRule = toLegacyRecurrenceRule;
const doesTimestampMatchRecurrence = (timestamp, rule, startAt) => {
    var _a, _b, _c;
    const normalizedRule = (0, exports.normalizeRecurrenceRule)(rule, startAt);
    const offsetMinutes = (_a = normalizedRule.timezoneOffsetMinutes) !== null && _a !== void 0 ? _a : 0;
    const currentLocal = toLocalDate(timestamp, offsetMinutes);
    const startLocal = toLocalDate(startAt, offsetMinutes);
    if (timestamp < startAt)
        return false;
    if (normalizedRule.frequency === "daily") {
        const daysDiff = Math.round((currentLocal.getTime() - startLocal.getTime()) / ONE_DAY_MS);
        return daysDiff >= 0 && daysDiff % normalizedRule.interval === 0;
    }
    if (normalizedRule.frequency === "weekly") {
        const weekdays = (_b = normalizedRule.weekdays) !== null && _b !== void 0 ? _b : [];
        if (!weekdays.includes(currentLocal.getUTCDay()))
            return false;
        const weeksSinceStart = getWeeksSinceStart(startLocal, currentLocal);
        return weeksSinceStart >= 0 && weeksSinceStart % normalizedRule.interval === 0;
    }
    const monthsOfYear = (_c = normalizedRule.monthsOfYear) !== null && _c !== void 0 ? _c : [];
    if (monthsOfYear.length && !monthsOfYear.includes(currentLocal.getUTCMonth() + 1)) {
        return false;
    }
    if (normalizedRule.frequency === "monthly") {
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
exports.doesTimestampMatchRecurrence = doesTimestampMatchRecurrence;
const findNextOccurrenceAt = (rule, startAt, afterTimestamp) => {
    var _a;
    const normalizedRule = (0, exports.normalizeRecurrenceRule)(rule, startAt);
    const offsetMinutes = (_a = normalizedRule.timezoneOffsetMinutes) !== null && _a !== void 0 ? _a : 0;
    const startLocal = toLocalDate(startAt, offsetMinutes);
    const searchFrom = Math.max(startAt, afterTimestamp + 1);
    const searchStartLocal = toLocalDate(searchFrom, offsetMinutes);
    const scheduledHour = startLocal.getUTCHours();
    const scheduledMinute = startLocal.getUTCMinutes();
    const scheduledSecond = startLocal.getUTCSeconds();
    const scheduledMillisecond = startLocal.getUTCMilliseconds();
    for (let dayOffset = 0; dayOffset <= MAX_SEARCH_DAYS; dayOffset++) {
        const localCandidate = new Date(Date.UTC(searchStartLocal.getUTCFullYear(), searchStartLocal.getUTCMonth(), searchStartLocal.getUTCDate() + dayOffset, scheduledHour, scheduledMinute, scheduledSecond, scheduledMillisecond));
        const candidateUtc = localCandidate.getTime() - (offsetMinutes * ONE_MINUTE_MS);
        if (candidateUtc < searchFrom)
            continue;
        if ((0, exports.doesTimestampMatchRecurrence)(candidateUtc, normalizedRule, startAt)) {
            return candidateUtc;
        }
    }
    return null;
};
exports.findNextOccurrenceAt = findNextOccurrenceAt;
//# sourceMappingURL=recurrence.js.map