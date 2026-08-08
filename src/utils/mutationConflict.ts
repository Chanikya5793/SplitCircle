export interface MutationExpectation {
  expectedRevision?: number;
  expectedUpdatedAt?: number;
}

export interface RevisionedEntity {
  revision?: number;
  updatedAt?: number;
}

export class MutationConflictError extends Error {
  readonly code = 'stale_write';

  constructor(entityLabel: string) {
    super(`${entityLabel} changed on another device. Refresh and try again.`);
    this.name = 'MutationConflictError';
  }
}

export class MutationGuardError extends Error {
  readonly code = 'invalid_mutation_guard';

  constructor(message: string) {
    super(message);
    this.name = 'MutationGuardError';
  }
}

export const entityRevision = (entity: RevisionedEntity | undefined): number => {
  const revision = entity?.revision;
  return typeof revision === 'number' && Number.isFinite(revision) && revision >= 1
    ? Math.floor(revision)
    : 1;
};

/**
 * Old records have no revision. Their updatedAt is the compatibility token;
 * newly written records use an explicit monotonic revision.
 */
export function assertMutationCurrent(
  current: RevisionedEntity | undefined,
  expectation: MutationExpectation,
  entityLabel: string,
): void {
  if (!current) throw new MutationConflictError(entityLabel);
  if (expectation.expectedRevision == null && expectation.expectedUpdatedAt == null) {
    throw new MutationGuardError(`Missing version information for ${entityLabel.toLowerCase()}.`);
  }
  if (
    expectation.expectedRevision != null &&
    entityRevision(current) !== expectation.expectedRevision
  ) {
    throw new MutationConflictError(entityLabel);
  }
  if (
    expectation.expectedRevision == null &&
    expectation.expectedUpdatedAt != null &&
    current.updatedAt !== expectation.expectedUpdatedAt
  ) {
    throw new MutationConflictError(entityLabel);
  }
}

export const expectationFor = (entity: RevisionedEntity): MutationExpectation =>
  entity.revision != null
    ? { expectedRevision: entityRevision(entity) }
    : entity.updatedAt != null
      ? { expectedUpdatedAt: entity.updatedAt }
      : { expectedRevision: 1 };

export const advanceEntityRevision = <T extends RevisionedEntity>(entity: T, updatedAt: number): T => ({
  ...entity,
  revision: entityRevision(entity) + 1,
  updatedAt,
});

export function replaceRevisionedEntity<T extends RevisionedEntity>(args: {
  entities: readonly T[];
  entityId: string;
  idOf: (entity: T) => string;
  proposed: T;
  expectation: MutationExpectation;
  entityLabel: string;
  updatedAt: number;
}): { entities: T[]; entity: T } {
  const current = args.entities.find((entity) => args.idOf(entity) === args.entityId);
  assertMutationCurrent(current, args.expectation, args.entityLabel);
  if (args.idOf(args.proposed) !== args.entityId) {
    throw new MutationGuardError(`${args.entityLabel} identifier cannot change.`);
  }
  // The server snapshot is authoritative. Never trust the proposal's revision
  // field even when the caller supplied a correctly guarded expectation.
  const entity = {
    ...args.proposed,
    revision: entityRevision(current) + 1,
    updatedAt: args.updatedAt,
  } as T;
  return {
    entity,
    entities: args.entities.map((item) => (args.idOf(item) === args.entityId ? entity : item)),
  };
}

export function removeRevisionedEntity<T extends RevisionedEntity>(args: {
  entities: readonly T[];
  entityId: string;
  idOf: (entity: T) => string;
  expectation: MutationExpectation;
  entityLabel: string;
}): T[] {
  const current = args.entities.find((entity) => args.idOf(entity) === args.entityId);
  assertMutationCurrent(current, args.expectation, args.entityLabel);
  return args.entities.filter((entity) => args.idOf(entity) !== args.entityId);
}
