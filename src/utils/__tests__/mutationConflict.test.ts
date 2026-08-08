import { describe, expect, it } from 'vitest';
import {
  MutationConflictError,
  MutationGuardError,
  assertMutationCurrent,
  advanceEntityRevision,
  entityRevision,
  expectationFor,
  removeRevisionedEntity,
  replaceRevisionedEntity,
} from '../mutationConflict';

describe('mutationConflict', () => {
  it('treats legacy entities as revision one', () => {
    expect(entityRevision({})).toBe(1);
    expect(expectationFor({ updatedAt: 42 })).toEqual({ expectedUpdatedAt: 42 });
    expect(expectationFor({})).toEqual({ expectedRevision: 1 });
  });

  it('normalizes corrupt revision values instead of propagating NaN', () => {
    expect(entityRevision({ revision: Number.NaN })).toBe(1);
    expect(entityRevision({ revision: -2 })).toBe(1);
    expect(entityRevision({ revision: 3.9 })).toBe(3);
  });

  it('advances revisions for non-editor mutations such as currency conversion', () => {
    expect(advanceEntityRevision<{ id: string; revision?: number; updatedAt?: number }>({ id: 'e1', revision: 2, updatedAt: 10 }, 20)).toEqual({
      id: 'e1', revision: 3, updatedAt: 20,
    });
    expect(advanceEntityRevision<{ id: string; revision?: number; updatedAt?: number }>({ id: 'legacy' }, 20)).toEqual({
      id: 'legacy', revision: 2, updatedAt: 20,
    });
  });

  it('accepts the current revision and rejects a stale revision', () => {
    expect(() => assertMutationCurrent({ revision: 3 }, { expectedRevision: 3 }, 'Expense')).not.toThrow();
    expect(() => assertMutationCurrent({ revision: 4 }, { expectedRevision: 3 }, 'Expense')).toThrow(
      MutationConflictError,
    );
  });

  it('uses updatedAt as the legacy compatibility token', () => {
    expect(() => assertMutationCurrent({ updatedAt: 42 }, { expectedUpdatedAt: 42 }, 'Expense')).not.toThrow();
    expect(() => assertMutationCurrent({ updatedAt: 43 }, { expectedUpdatedAt: 42 }, 'Expense')).toThrow(
      'changed on another device',
    );
  });

  it('rejects a delete when the entity disappeared', () => {
    expect(() => assertMutationCurrent(undefined, { expectedRevision: 1 }, 'Settlement')).toThrow(
      MutationConflictError,
    );
  });

  it('rejects an explicitly empty guard instead of silently disabling concurrency checks', () => {
    expect(() => assertMutationCurrent({ revision: 2 }, {}, 'Expense')).toThrow(MutationGuardError);
  });

  it('replaces against the server snapshot, increments revision, and preserves siblings', () => {
    const current: { id: string; title: string; revision?: number; updatedAt?: number }[] = [
      { id: 'e1', title: 'old', revision: 4, updatedAt: 10 },
      { id: 'e2', title: 'keep', revision: 2, updatedAt: 9 },
    ];
    const result = replaceRevisionedEntity({
      entities: current,
      entityId: 'e1',
      idOf: (entity) => entity.id,
      proposed: { id: 'e1', title: 'new', updatedAt: 10 },
      expectation: { expectedRevision: 4 },
      entityLabel: 'Expense',
      updatedAt: 20,
    });
    expect(result.entity).toEqual({ id: 'e1', title: 'new', revision: 5, updatedAt: 20 });
    expect(result.entities[1]).toBe(current[1]);
  });

  it('rejects a stale replacement and an identifier-changing replacement', () => {
    const entities = [{ id: 'e1', revision: 2, updatedAt: 10 }];
    expect(() => replaceRevisionedEntity({
      entities,
      entityId: 'e1',
      idOf: (entity) => entity.id,
      proposed: { id: 'e1', revision: 1, updatedAt: 5 },
      expectation: { expectedRevision: 1 },
      entityLabel: 'Expense',
      updatedAt: 20,
    })).toThrow(MutationConflictError);
    expect(() => replaceRevisionedEntity({
      entities,
      entityId: 'e1',
      idOf: (entity) => entity.id,
      proposed: { id: 'e2', revision: 2, updatedAt: 10 },
      expectation: { expectedRevision: 2 },
      entityLabel: 'Expense',
      updatedAt: 20,
    })).toThrow(MutationGuardError);
  });

  it('removes exactly the guarded entity from the server snapshot', () => {
    const current = [{ id: 's1', revision: 2 }, { id: 's2', revision: 1 }];
    const next = removeRevisionedEntity({
      entities: current,
      entityId: 's1',
      idOf: (entity) => entity.id,
      expectation: { expectedRevision: 2 },
      entityLabel: 'Settlement',
    });
    expect(next).toEqual([{ id: 's2', revision: 1 }]);
  });
});
