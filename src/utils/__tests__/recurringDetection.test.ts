/**
 * recurringDetection (ai_layer/docs/26) — deterministic clustering: cadence
 * bands, liveness, amount stability, exclusions, and title matching.
 */

import { describe, expect, it } from 'vitest';
import type { Expense } from '@/models';
import {
    detectRecurringCandidates,
    matchCandidate,
    normalizeTitleKey,
} from '../recurringDetection';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-01T12:00:00Z').getTime();

let seq = 0;
const expense = (
    title: string,
    amount: number,
    createdAt: number,
    extra: Partial<Expense> = {},
): Expense => ({
    expenseId: `e${++seq}`,
    groupId: 'g1',
    title,
    category: 'Subscriptions',
    amount,
    paidBy: 'u1',
    splitType: 'equal',
    participants: [
        { userId: 'u1', share: amount / 2 },
        { userId: 'u2', share: amount / 2 },
    ],
    settled: false,
    createdAt,
    updatedAt: createdAt,
    ...extra,
});

/** Three monthly Netflix charges ending ~15 days before NOW (alive). */
const monthlyNetflix = () => [
    expense('Netflix', 649, NOW - 75 * DAY),
    expense('Netflix', 649, NOW - 45 * DAY),
    expense('Netflix', 649, NOW - 15 * DAY),
];

describe('normalizeTitleKey', () => {
    it('lowercases, strips emoji/punctuation, collapses whitespace', () => {
        expect(normalizeTitleKey('  Netflix 🎬  (family)!! ')).toBe('netflix family');
        expect(normalizeTitleKey('WI-FI bill')).toBe('wi fi bill');
    });
});

describe('detectRecurringCandidates', () => {
    it('finds a monthly pattern with a stable amount', () => {
        const out = detectRecurringCandidates(monthlyNetflix(), { now: NOW });
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            key: 'netflix',
            cadence: 'monthly',
            amountStable: true,
            medianAmount: 649,
            occurrenceCount: 3,
            paidBy: 'u1',
        });
        expect(out[0].dayOfMonth).toBeDefined();
    });

    it('finds a weekly pattern and reports the modal weekday', () => {
        const base = NOW - 22 * DAY;
        const out = detectRecurringCandidates(
            [0, 7, 14, 21].map((d) => expense('Groceries run', 80, base + d * DAY)),
            { now: NOW },
        );
        expect(out).toHaveLength(1);
        expect(out[0].cadence).toBe('weekly');
        expect(out[0].weekday).toBe(new Date(base).getDay());
    });

    it('flags unstable amounts (variable-shaped bills)', () => {
        const out = detectRecurringCandidates(
            [
                expense('Electricity', 1200, NOW - 75 * DAY),
                expense('Electricity', 2400, NOW - 45 * DAY),
                expense('Electricity', 1700, NOW - 15 * DAY),
            ],
            { now: NOW },
        );
        expect(out).toHaveLength(1);
        expect(out[0].amountStable).toBe(false);
    });

    it('requires at least three occurrences', () => {
        const out = detectRecurringCandidates(monthlyNetflix().slice(1), { now: NOW });
        expect(out).toHaveLength(0);
    });

    it('rejects gaps outside the weekly/monthly bands', () => {
        const out = detectRecurringCandidates(
            [
                expense('Random thing', 50, NOW - 40 * DAY),
                expense('Random thing', 50, NOW - 25 * DAY), // 15-day gap: neither band
                expense('Random thing', 50, NOW - 10 * DAY),
            ],
            { now: NOW },
        );
        expect(out).toHaveLength(0);
    });

    it('drops dead patterns (last occurrence too old)', () => {
        const out = detectRecurringCandidates(
            [
                expense('Netflix', 649, NOW - 150 * DAY),
                expense('Netflix', 649, NOW - 120 * DAY),
                expense('Netflix', 649, NOW - 90 * DAY),
            ],
            { now: NOW },
        );
        expect(out).toHaveLength(0);
    });

    it('never clusters bill-generated expenses and honors excludeKeys', () => {
        const generated = monthlyNetflix().map((e) => ({
            ...e,
            recurring: { billId: 'b1', occurrenceAt: e.createdAt },
        }));
        expect(detectRecurringCandidates(generated, { now: NOW })).toHaveLength(0);

        const out = detectRecurringCandidates(monthlyNetflix(), {
            now: NOW,
            excludeKeys: ['Netflix 🎬'],
        });
        expect(out).toHaveLength(0);
    });

    it('ignores same-day duplicates when measuring cadence', () => {
        const rows = [
            ...monthlyNetflix(),
            expense('Netflix', 649, NOW - 15 * DAY + 60_000), // correction dupe
        ];
        const out = detectRecurringCandidates(rows, { now: NOW });
        expect(out).toHaveLength(1);
        expect(out[0].cadence).toBe('monthly');
    });
});

describe('matchCandidate', () => {
    it('matches a typed title against a detected cluster', () => {
        const candidates = detectRecurringCandidates(monthlyNetflix(), { now: NOW });
        expect(matchCandidate('NETFLIX!', candidates)?.key).toBe('netflix');
        expect(matchCandidate('Spotify', candidates)).toBeUndefined();
    });
});
