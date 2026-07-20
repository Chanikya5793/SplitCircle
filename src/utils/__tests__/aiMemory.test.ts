/**
 * aiMemory.test.ts — the memory pure logic (doc 25 Q2): injection block
 * building, entity-fix learning, pattern counters, and "remember …" parsing.
 */
import { describe, expect, it } from 'vitest';

import {
  buildMemoryBlock,
  bumpCounter,
  DEFAULT_TOGGLES,
  entityFixMap,
  entityFixText,
  extractClarifyAlias,
  parseRememberCommand,
  PATTERN_KEY_CAP,
  patternHintLine,
  patternRows,
  shouldPromoteFix,
  type ClarifyPick,
  type MemoryItem,
} from '../aiMemory';

let seq = 0;
const item = (kind: MemoryItem['kind'], text: string, over: Partial<MemoryItem> = {}): MemoryItem => ({
  id: `i${++seq}`,
  kind,
  text,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('buildMemoryBlock', () => {
  const items = [
    item('fact', 'Maya is my sister'),
    item('preference', 'keep answers short'),
    item('entityFix', '"sam" means Sam Lee', { key: 'sam', value: 'Sam Lee' }),
  ];

  it('orders preference → fixes → facts, appends the pattern line', () => {
    const block = buildMemoryBlock(items, DEFAULT_TOGGLES, 'often asks about: Food (6×)');
    const lines = block.split('\n');
    expect(lines[0]).toContain('MEMORY');
    expect(lines[1]).toContain('keep answers short');
    expect(lines[2]).toContain('"sam" means Sam Lee');
    expect(lines[3]).toContain('Maya is my sister');
    expect(lines[4]).toContain('often asks about');
  });

  it('respects per-kind toggles', () => {
    const block = buildMemoryBlock(
      items,
      { ...DEFAULT_TOGGLES, fact: false, pattern: false },
      'often asks about: Food (6×)',
    );
    expect(block).not.toContain('Maya');
    expect(block).not.toContain('often asks');
    expect(block).toContain('keep answers short');
  });

  it('returns empty when nothing survives', () => {
    expect(buildMemoryBlock([], DEFAULT_TOGGLES, null)).toBe('');
    expect(
      buildMemoryBlock(items, { entityFix: false, fact: false, preference: false, pattern: false }),
    ).toBe('');
  });

  it('trims to the token cap instead of overflowing', () => {
    const many = Array.from({ length: 100 }, (_, i) => item('fact', `fact number ${i} ${'x'.repeat(40)}`));
    const block = buildMemoryBlock(many, DEFAULT_TOGGLES);
    expect(block.length).toBeLessThan(1400); // ~300 tokens × 4 chars + header slack
    expect(block).toContain('fact number 0');
  });
});

describe('entity-fix learning', () => {
  it('extracts the shared alias from the clarify-causing message', () => {
    expect(extractClarifyAlias('what does sam owe me', ['Sam Lee', 'Samir'])).toBe('sam');
    expect(extractClarifyAlias('how much for maya', ['Sam Lee', 'Samir'])).toBeNull();
    expect(extractClarifyAlias('', ['Sam Lee', 'Samir'])).toBeNull();
  });

  it('promotes after two consistent picks, not one, not conflicting', () => {
    const pick = (choice: string): ClarifyPick => ({ alias: 'sam', choice, at: 0 });
    expect(shouldPromoteFix([pick('Sam Lee')], 'sam')).toBeNull();
    expect(shouldPromoteFix([pick('Sam Lee'), pick('Samir')], 'sam')).toBeNull();
    expect(shouldPromoteFix([pick('Samir'), pick('Sam Lee'), pick('Sam Lee')], 'sam')).toBe('Sam Lee');
  });

  it('fix map honors the toggle', () => {
    const items2 = [item('entityFix', entityFixText('sam', 'Sam Lee'), { key: 'sam', value: 'Sam Lee' })];
    expect(entityFixMap(items2, DEFAULT_TOGGLES)).toEqual({ sam: 'Sam Lee' });
    expect(entityFixMap(items2, { ...DEFAULT_TOGGLES, entityFix: false })).toEqual({});
  });
});

describe('patterns', () => {
  it('bumps and evicts the smallest at the cap', () => {
    let c: Record<string, number> = {};
    for (let i = 0; i < PATTERN_KEY_CAP; i++) c = bumpCounter(c, `topic:cat${i}`);
    c = bumpCounter(c, 'topic:cat1'); // cat1 = 2, everything else 1
    c = bumpCounter(c, 'topic:new'); // must evict a 1-count key, keep cat1
    expect(Object.keys(c)).toHaveLength(PATTERN_KEY_CAP);
    expect(c['topic:cat1']).toBe(2);
  });

  it('hint line and rows require the minimum count', () => {
    const c = { 'topic:Food': 6, 'period:last month': 4, 'topic:Gas': 1 };
    expect(patternHintLine(c)).toBe('often asks about: Food (6×), last month (4×)');
    expect(patternRows(c).map((r) => r.text)).toEqual(['Food', 'last month']);
    expect(patternHintLine({ 'topic:Gas': 1 })).toBeNull();
  });
});

describe('parseRememberCommand', () => {
  it('parses facts and preferences with lead-stripping', () => {
    expect(parseRememberCommand('remember that Maya is my sister', false)).toEqual({
      kind: 'fact',
      text: 'Maya is my sister',
    });
    expect(parseRememberCommand("don't forget: never suggest settling up.", false)).toEqual({
      kind: 'preference',
      text: 'never suggest settling up',
    });
    expect(parseRememberCommand('Remember keep answers short', false)).toEqual({
      kind: 'preference',
      text: 'keep answers short',
    });
  });

  it('amounts belong to the money flows, not memory', () => {
    expect(parseRememberCommand('remember I paid Sam 20', true)).toBeNull();
  });

  it('non-remember and empty remainders are null', () => {
    expect(parseRememberCommand('what do you remember?', false)).toBeNull();
    expect(parseRememberCommand('remember', false)).toBeNull();
  });
});
