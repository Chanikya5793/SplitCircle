import { describe, expect, it } from 'vitest';
import { AI_CONVERSATIONAL_ACTIVE_COPY, AI_INDEX_PRIVACY_COPY } from '../aiDisclosure';

describe('AI privacy disclosure', () => {
  it('does not make the former absolute nothing-leaves-device claim', () => {
    expect(AI_INDEX_PRIVACY_COPY.toLowerCase()).not.toContain('nothing about your spending leaves');
    expect(AI_INDEX_PRIVACY_COPY).toContain('Private Cloud');
    expect(AI_INDEX_PRIVACY_COPY).toContain('exact calculation');
  });

  it('separates exact calculations from the engine that narrates an answer', () => {
    expect(AI_CONVERSATIONAL_ACTIVE_COPY).toContain('on-device model');
    expect(AI_CONVERSATIONAL_ACTIVE_COPY).toContain('Private Cloud Compute');
    expect(AI_CONVERSATIONAL_ACTIVE_COPY).toContain('each answer shows which engine');
    expect(AI_CONVERSATIONAL_ACTIVE_COPY).toContain('computed exactly');
  });
});
