import { afterEach, describe, expect, it } from 'vitest';

import { parseAiEnv } from '../../../src/config/ai.env.js';
import { ProductAiService } from '../../../src/infrastructure/ai/application/ProductAiService.js';
import {
  MockAiAdapter,
  mockDriverSwitches,
} from '../../../src/infrastructure/ai/adapters/mock/MockAiAdapter.js';
import { InMemoryAiAuditRecorder } from '../../../src/infrastructure/ai/persistence/AiAuditRepository.js';

const QUESTION_SCHEMA = {
  type: 'object',
  required: ['schemaVersion', 'blueprintId', 'questions'],
  properties: {
    schemaVersion: { type: 'integer', minimum: 1 },
    blueprintId: { type: 'string' },
    questions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'type', 'stem', 'options', 'answerKey'],
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          stem: { type: 'string' },
          options: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              required: ['id', 'text'],
              properties: { id: { type: 'string' }, text: { type: 'string' } },
            },
          },
          answerKey: {
            type: 'object',
            required: ['optionId'],
            properties: { optionId: { type: 'string' } },
          },
          explanation: { type: 'string' },
        },
      },
    },
  },
} as const;

function buildService(
  env = parseAiEnv({} as NodeJS.ProcessEnv),
  recorder = new InMemoryAiAuditRecorder(),
): { service: ProductAiService; recorder: InMemoryAiAuditRecorder } {
  const adapter = new MockAiAdapter();
  const service = new ProductAiService({
    adapter,
    env,
    schemas: new Map([['smoke.test.v1', QUESTION_SCHEMA as Record<string, unknown>]]),
    audit: recorder,
  });
  return { service, recorder };
}

afterEach(() => {
  mockDriverSwitches.rateLimited = false;
  mockDriverSwitches.refused = false;
  mockDriverSwitches.schemaInvalid = false;
  mockDriverSwitches.forcedOutcome = null;
});

describe('ProductAiService', () => {
  it('produces a structured success outcome and writes a succeeded audit row', async () => {
    const { service, recorder } = buildService();
    const result = await service.run({
      workspaceId: 'w1',
      actorId: 'a1',
      promptTemplateId: 'smoke.test.v1',
      schemaVersion: 1,
      prompt: 'Topik: Fotosintesis. Buat 1 soal.',
      schema: QUESTION_SCHEMA,
      tokenEstimateHint: null,
    });
    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') {
      expect(result.validated.schemaVersion).toBe(1);
    }
    const rows = recorder.rowsSnapshot();
    expect(rows.length).toBe(1);
    expect(rows[0]?.outcome).toBe('succeeded');
    expect(rows[0]?.driver).toBe('mock');
    expect(rows[0]?.promptByteLength).toBe(
      Buffer.byteLength('Topik: Fotosintesis. Buat 1 soal.', 'utf8'),
    );
    expect(JSON.stringify(rows).includes('Topik: Fotosintesis.')).toBe(false);
  });

  it('redacts prompt body in audit rows — raw prompt never appears', async () => {
    const { service, recorder } = buildService();
    await service.run({
      workspaceId: 'w1',
      actorId: 'a1',
      promptTemplateId: 'smoke.test.v1',
      schemaVersion: 1,
      prompt: 'PII-FIREHOSE:CUIT-1234-5678',
      schema: QUESTION_SCHEMA,
      tokenEstimateHint: null,
    });
    const flat = JSON.stringify(recorder.rowsSnapshot());
    expect(flat.includes('PII-FIREHOSE')).toBe(false);
  });

  it('caps schema repair attempts and surfaces SCHEMA_VALIDATION_FAILED', async () => {
    const env = parseAiEnv({ AI_SCHEMA_REPAIR_MAX: '1' } as NodeJS.ProcessEnv);
    const { service, recorder } = buildService(env);
    mockDriverSwitches.forcedOutcome = {
      kind: 'schema_invalid',
      providerModelId: 'mock-fixture-v1',
      redactedResponseFingerprint: 'fingerprint:[redacted]',
      reason: 'parse_error',
      responseText: null,
    };
    const result = await service.run({
      workspaceId: 'w1',
      actorId: 'a1',
      promptTemplateId: 'smoke.test.v1',
      schemaVersion: 1,
      prompt: 'Schema repair probe.',
      schema: QUESTION_SCHEMA,
      tokenEstimateHint: null,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.outcome).toBe('schema_invalid');
      expect(result.error.code).toBe('SCHEMA_VALIDATION_FAILED');
      expect(result.schemaRepairAttempts).toBe(1);
    }
    const rows = recorder.rowsSnapshot();
    // Two audit rows: one dedicated repair-attempt row plus the terminal cap-hit
    // row written by completeSchemaFailure(). Both are intentionally tagged
    // `schema_repair` to preserve the same stable outcome vocabulary in the ADR.
    expect(rows.filter((r) => r.outcome === 'schema_repair').length).toBe(2);
    expect(rows.some((r) => r.outcome === 'succeeded')).toBe(false);
    mockDriverSwitches.forcedOutcome = null;
  });

  it('maps rate-limit outcome to envelope code RATE_LIMITED', async () => {
    const { service, recorder } = buildService();
    mockDriverSwitches.rateLimited = true;
    const result = await service.run({
      workspaceId: 'w1',
      actorId: 'a1',
      promptTemplateId: 'smoke.test.v1',
      schemaVersion: 1,
      prompt: 'rate limit probe',
      schema: QUESTION_SCHEMA,
      tokenEstimateHint: null,
    });
    mockDriverSwitches.rateLimited = false;
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.outcome).toBe('rate_limited');
      expect(result.error.code).toBe('RATE_LIMITED');
      expect(result.error.retryAfterMs).toBe(1_000);
    }
    expect(recorder.byOutcome('rate_limited').length).toBe(1);
  });

  it('maps refusal outcome to envelope code PROVIDER_REFUSED', async () => {
    const { service, recorder } = buildService();
    mockDriverSwitches.refused = true;
    const result = await service.run({
      workspaceId: 'w1',
      actorId: 'a1',
      promptTemplateId: 'smoke.test.v1',
      schemaVersion: 1,
      prompt: 'refusal probe',
      schema: QUESTION_SCHEMA,
      tokenEstimateHint: null,
    });
    mockDriverSwitches.refused = false;
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.outcome).toBe('refused');
      expect(result.error.code).toBe('PROVIDER_REFUSED');
    }
    expect(recorder.byOutcome('refused').length).toBe(1);
  });

  it('queues through the same audit path without ever invoking the openai driver', async () => {
    const env = parseAiEnv({ AI_DRIVER: 'mock' } as NodeJS.ProcessEnv);
    const { service, recorder } = buildService(env);
    const result = await service.run({
      workspaceId: 'w1',
      actorId: 'a1',
      promptTemplateId: 'smoke.test.v1',
      schemaVersion: 1,
      prompt: 'AI_DRIVER=mock probe',
      schema: QUESTION_SCHEMA,
      tokenEstimateHint: null,
    });
    expect(result.status).toBe('succeeded');
    expect(recorder.byDriver('openai').length).toBe(0);
    expect(recorder.byDriver('mock').length).toBe(1);
  });
});
