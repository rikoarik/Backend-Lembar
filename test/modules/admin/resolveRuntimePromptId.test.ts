import { describe, expect, it } from 'vitest';
import { resolveRuntimePromptId } from '../../../src/modules/admin/adapters/http/aiPromptRoutes.js';

describe('resolveRuntimePromptId', () => {
  it('maps display names to canonical runtime ids', () => {
    expect(resolveRuntimePromptId('generate.v3', 'generate-v3')).toBe('question-generation-v1');
    expect(resolveRuntimePromptId('quality.guard', 'quality-guard')).toBe('quality.guard');
  });
});
