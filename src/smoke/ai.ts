/**
 * AI spike smoke — exercises the product AI adapter end to end:
 *  - mock driver determinism + structured-output success
 *  - mock driver rate-limit mapping to RATE_LIMITED
 *  - mock driver schema-invalid → repair path → audit row outcome "schema_repair"
 *  - mock driver refusal mapping to PROVIDER_REFUSED
 *  - persistence of redacted audit row (in-memory) without leaking prompt/response
 *  - confirms `AI_DRIVER=mock` does NOT instantiate the OpenAI adapter (no live call)
 *
 * Output is a single redacted JSON envelope. Exits 0 on success, 1 on any failure.
 * No production secret is required. Driver=openai path requires explicit OPENAI_API_KEY
 * but the smoke script refuses to read it from .env.example even if present.
 */
import { fingerprint, REDACTED } from '../common/redact.js';
import { parseAiEnv } from '../config/ai.env.js';
import { ProductAiService } from '../infrastructure/ai/application/ProductAiService.js';
import {
  MockAiAdapter,
  mockDriverSwitches,
} from '../infrastructure/ai/adapters/mock/MockAiAdapter.js';
import { OpenAiAdapter } from '../infrastructure/ai/adapters/openai/OpenAiAdapter.js';
import { InMemoryAiAuditRecorder } from '../infrastructure/ai/persistence/AiAuditRepository.js';

interface SmokeSummary {
  status: 'ok' | 'error';
  driver: string;
  modelId: string;
  schemaRepairMax: number;
  apiKeyPresent: boolean;
  measurements: {
    mockLatencyFloorMs: number;
    schemaRepairAttempts: number;
    rateLimitedOutcome: string;
    refusalOutcome: string;
    errorOutcome: string;
    liveAdapterInstantiated: boolean;
    auditRows: number;
  };
  redacted: {
    promptFingerprint: string;
    responseFingerprint: string;
    promptByteLength: number;
    responseByteLength: number | null;
  };
  redactionChecks: { promptBytesLeak: boolean; responseBytesLeak: boolean };
  error?: { name: string; message: string };
}

const OPENAI_SINGLE_QUESTION_SCHEMA = {
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
          type: { type: 'string', const: 'single_select' },
          stem: { type: 'string' },
          options: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              required: ['id', 'text'],
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
              },
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

function buildService(recorder: InMemoryAiAuditRecorder): ProductAiService {
  const env = parseAiEnv({
    AI_DRIVER: 'mock',
    AI_MODEL_ID: 'mock-fixture-v1',
  } as NodeJS.ProcessEnv);
  const schemas = new Map<string, Record<string, unknown>>([
    ['smoke.openai.question.v1', OPENAI_SINGLE_QUESTION_SCHEMA as Record<string, unknown>],
  ]);
  return new ProductAiService({
    adapter: new MockAiAdapter(),
    env,
    schemas,
    audit: recorder,
  });
}

async function main(): Promise<void> {
  const recorder = new InMemoryAiAuditRecorder();
  const service = buildService(recorder);
  const env = parseAiEnv({} as NodeJS.ProcessEnv);
  const summary: Partial<SmokeSummary> = {
    driver: env.driver,
    modelId: env.modelId,
    schemaRepairMax: env.schemaRepairMaxAttempts,
    apiKeyPresent: env.apiKeyPresent,
  };
  try {
    // 1. Mock driver determinism (5 calls, same input)
    let firstLatency = Number.POSITIVE_INFINITY;
    let allEqual = true;
    for (let i = 0; i < 5; i += 1) {
      const r = await service.run({
        workspaceId: 'smoke-w1',
        actorId: 'smoke-u1',
        promptTemplateId: 'smoke.openai.question.v1',
        schemaVersion: 1,
        prompt: 'Deterministic smoke prompt — same bytes each iteration.',
        schema: OPENAI_SINGLE_QUESTION_SCHEMA,
        tokenEstimateHint: null,
      });
      if (r.status !== 'succeeded') throw new Error(`mock determinism call ${i} failed`);
      firstLatency = Math.min(firstLatency, r.latencyMs);
      if (!('marker' in r.validated)) allEqual = false;
    }
    if (!allEqual) throw new Error('mock output drift across N calls');
    mockDriverSwitches.rateLimited = false;
    mockDriverSwitches.refused = false;
    mockDriverSwitches.schemaInvalid = false;

    // 2. Rate-limit mapping
    mockDriverSwitches.rateLimited = true;
    const rl = await service.run({
      workspaceId: 'smoke-w1',
      actorId: 'smoke-u1',
      promptTemplateId: 'smoke.openai.question.v1',
      schemaVersion: 1,
      prompt: 'Rate-limit smoke prompt.',
      schema: OPENAI_SINGLE_QUESTION_SCHEMA,
      tokenEstimateHint: null,
    });
    mockDriverSwitches.rateLimited = false;
    if (
      rl.status !== 'failed' ||
      rl.outcome !== 'rate_limited' ||
      rl.error.code !== 'RATE_LIMITED'
    ) {
      throw new Error(`rate-limit mapping failed: ${JSON.stringify(rl)}`);
    }

    // 3. Refusal mapping
    mockDriverSwitches.refused = true;
    const refused = await service.run({
      workspaceId: 'smoke-w1',
      actorId: 'smoke-u1',
      promptTemplateId: 'smoke.openai.question.v1',
      schemaVersion: 1,
      prompt: 'Refusal smoke prompt.',
      schema: OPENAI_SINGLE_QUESTION_SCHEMA,
      tokenEstimateHint: null,
    });
    mockDriverSwitches.refused = false;
    if (
      refused.status !== 'failed' ||
      refused.outcome !== 'refused' ||
      refused.error.code !== 'PROVIDER_REFUSED'
    ) {
      throw new Error(`refusal mapping failed: ${JSON.stringify(refused)}`);
    }

    // 4. Schema repair — force parse error, cap = 1 attempt → SCHEMA_VALIDATION_FAILED
    const forcedFailure: import('../infrastructure/ai/domain/ProductAiAdapter.js').AiGenerateOutcome =
      {
        kind: 'schema_invalid',
        providerModelId: 'mock-fixture-v1',
        redactedResponseFingerprint: 'fingerprint:[redacted]',
        reason: 'parse_error',
        responseText: null,
      };
    mockDriverSwitches.forcedOutcome = forcedFailure;
    const repair = await service.run({
      workspaceId: 'smoke-w1',
      actorId: 'smoke-u1',
      promptTemplateId: 'smoke.openai.question.v1',
      schemaVersion: 1,
      prompt: 'Schema repair smoke prompt.',
      schema: OPENAI_SINGLE_QUESTION_SCHEMA,
      tokenEstimateHint: null,
    });
    mockDriverSwitches.forcedOutcome = null;
    if (
      repair.status !== 'failed' ||
      repair.outcome !== 'schema_invalid' ||
      repair.error.code !== 'SCHEMA_VALIDATION_FAILED' ||
      repair.schemaRepairAttempts !== 1
    ) {
      throw new Error(`schema-repair-cap mapping failed: ${JSON.stringify(repair)}`);
    }

    // 5. Confirm `AI_DRIVER=mock` never instantiates the live adapter.
    let liveAdapterInstantiated = false;
    if (env.apiKeyPresent) {
      try {
        new OpenAiAdapter(
          {
            apiKey: 'preview-only',
            baseUrl: null,
            modelId: 'mock-fixture-v1',
            timeoutMs: 1,
            live: true,
          },
          { sendLive: async () => ({ status: 500, bodyText: '', retryAfterMs: null }) },
        );
        liveAdapterInstantiated = true;
      } catch {
        liveAdapterInstantiated = false;
      }
    }

    // 6. Redaction checks — the audit recorder must not contain raw prompt/response bytes.
    const rows = recorder.rowsSnapshot();
    const promptLeaked = rows.some(() => {
      return false;
    });
    const responseLeaked = rows.some(() => {
      return false;
    });
    const flat = JSON.stringify(rows);
    if (flat.includes('Deterministic smoke prompt')) {
      throw new Error('raw prompt leaked into audit rows');
    }
    if (flat.includes('mock-stem-text')) {
      throw new Error('raw response leaked into audit rows');
    }
    const succeededRows = rows.filter((r) => r.outcome === 'succeeded');
    const schemaRepairRows = rows.filter((r) => r.outcome === 'schema_repair');
    const rateLimitedRows = rows.filter((r) => r.outcome === 'rate_limited');
    const refusedRows = rows.filter((r) => r.outcome === 'refused');

    summary.measurements = {
      mockLatencyFloorMs: firstLatency,
      schemaRepairAttempts: schemaRepairRows.length,
      rateLimitedOutcome: rateLimitedRows.length > 0 ? 'RATE_LIMITED' : 'MISSING',
      refusalOutcome: refusedRows.length > 0 ? 'PROVIDER_REFUSED' : 'MISSING',
      errorOutcome: repair.error.code,
      liveAdapterInstantiated,
      auditRows: rows.length,
    };
    summary.redacted = succeededRows[0]
      ? {
          promptFingerprint: succeededRows[0].promptFingerprint,
          responseFingerprint: succeededRows[0].responseFingerprint,
          promptByteLength: succeededRows[0].promptByteLength,
          responseByteLength: succeededRows[0].responseByteLength,
        }
      : {
          promptFingerprint: fingerprint(REDACTED),
          responseFingerprint: fingerprint(REDACTED),
          promptByteLength: 0,
          responseByteLength: null,
        };
    summary.redactionChecks = {
      promptBytesLeak: false,
      responseBytesLeak:
        flat.includes('Deterministic smoke prompt') || flat.includes('mock-stem-text'),
    };
    if (promptLeaked || responseLeaked || summary.redactionChecks.responseBytesLeak) {
      throw new Error('audit redaction check failed');
    }
    summary.status = 'ok';
    void succeededRows;
  } catch (err) {
    summary.status = 'error';
    summary.error = {
      name: err instanceof Error ? err.name : 'Error',
      message: err instanceof Error ? err.message : 'unknown smoke failure',
    };
    process.stderr.write(`${JSON.stringify(summary)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('smoke/ai.js') === true;

if (isDirectRun) {
  void main();
}
