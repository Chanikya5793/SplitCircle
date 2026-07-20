/**
 * aiMemoryService.test.ts — the memory store (doc 25 Q2) over the in-memory
 * AsyncStorage mock: round-trips, toggles, silent entity-fix promotion,
 * pattern counters, and the merged injection/fix-map the pipeline consumes.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { __clearAsyncStorageStore } from './mocks/async-storage';
import {
  __clearMemoryCache,
  addItem,
  deleteItem,
  getEntityFixes,
  getInjection,
  getToggles,
  listLedger,
  recordClarifyPick,
  recordTurnPattern,
  setToggle,
  wipeAll,
} from '../aiMemoryService';

beforeEach(() => {
  __clearAsyncStorageStore();
  __clearMemoryCache();
});

describe('items & ledger', () => {
  it('add / list / delete round-trip', async () => {
    const added = await addItem('global', 'fact', 'Maya is my sister');
    expect((await listLedger('global')).items).toHaveLength(1);
    await deleteItem('global', added.id);
    expect((await listLedger('global')).items).toHaveLength(0);
  });

  it('wipeAll clears every tracked scope', async () => {
    await addItem('global', 'fact', 'a');
    await addItem('group:g1', 'preference', 'b');
    await wipeAll();
    expect((await listLedger('global')).items).toHaveLength(0);
    expect((await listLedger('group:g1')).items).toHaveLength(0);
  });
});

describe('entity-fix promotion', () => {
  it('two consistent picks promote; the fix map serves it', async () => {
    await recordClarifyPick('group:g1', 'sam', 'Sam Lee');
    expect(await getEntityFixes(['group:g1'])).toEqual({});
    await recordClarifyPick('group:g1', 'sam', 'Sam Lee');
    expect(await getEntityFixes(['global', 'group:g1'])).toEqual({ sam: 'Sam Lee' });
    const ledger = await listLedger('group:g1');
    expect(ledger.items[0]).toMatchObject({ kind: 'entityFix', key: 'sam', value: 'Sam Lee' });
    expect(ledger.items[0].provenance).toContain('picked twice');
  });

  it('conflicting picks do not promote', async () => {
    await recordClarifyPick('group:g1', 'sam', 'Sam Lee');
    await recordClarifyPick('group:g1', 'sam', 'Samir');
    expect(await getEntityFixes(['group:g1'])).toEqual({});
  });
});

describe('patterns & toggles', () => {
  it('counters accrue and surface after the minimum count', async () => {
    for (let i = 0; i < 3; i++) await recordTurnPattern('group:g1', { category: 'Food' });
    const { patterns } = await listLedger('group:g1');
    expect(patterns[0]).toMatchObject({ text: 'Food', provenance: 'asked 3×' });
  });

  it('the pattern toggle stops recording', async () => {
    await setToggle('pattern', false);
    await recordTurnPattern('group:g1', { category: 'Food' });
    expect((await listLedger('group:g1')).patterns).toHaveLength(0);
    expect((await getToggles()).pattern).toBe(false);
  });
});

describe('injection', () => {
  it('merges global + scope, respects toggles', async () => {
    await addItem('global', 'preference', 'keep answers short');
    await addItem('group:g1', 'fact', 'we call Costco runs the big shop');
    const block = await getInjection(['global', 'group:g1']);
    expect(block).toContain('keep answers short');
    expect(block).toContain('big shop');
    await setToggle('fact', false);
    const filtered = await getInjection(['global', 'group:g1']);
    expect(filtered).not.toContain('big shop');
    expect(filtered).toContain('keep answers short');
  });

  it('empty memory injects nothing', async () => {
    expect(await getInjection(['global', 'personal'])).toBe('');
  });
});
