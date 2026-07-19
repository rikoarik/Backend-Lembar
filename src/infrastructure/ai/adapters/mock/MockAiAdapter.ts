/**
 * Mock AI adapter for dev/test/CI.
 *
 * The fixture model is deterministic per `(workspaceId, promptTemplateId,
 * schemaVersion)`: the same three inputs always yield the same byte-for-byte
 * JSON output, no hidden clock, no mock latency. This guarantees the
 * acceptance criterion "mock adapter determinism across N calls" and gives
 * the schema-repair path an honest fixture to fail on.
 *
 * Damage controls for tests live on the static `failNext*` switches so tests
 * can exercise the discriminated outcomes without touching the adapter API.
 */
import type {
  AiAdapterMeta,
  AiGenerateInput,
  AiGenerateOutcome,
  AiGenerateResult,
  ProductAiAdapter,
} from '../../domain/ProductAiAdapter.js';

interface MockFixture {
  ok: true;
  payload: Record<string, unknown>;
}

interface MockFixtureRegistry {
  schemas: Set<string>;
  fixtures: Map<string, (input: AiGenerateInput) => MockFixture>;
}

const REGISTRY: MockFixtureRegistry = {
  schemas: new Set(),
  fixtures: new Map(),
};

export function registerMockFixture(
  promptTemplateId: string,
  build: (input: AiGenerateInput) => MockFixture,
): void {
  REGISTRY.fixtures.set(promptTemplateId, build);
}

export function clearMockFixtures(): void {
  REGISTRY.fixtures.clear();
}

/** Statics used by tests to force discriminated failure paths. */
export const mockDriverSwitches = {
  rateLimited: false,
  refused: false,
  schemaInvalid: false,
  /** If set, every call to `generate` returns this error outcome (mapped to a normal outcome). */
  forcedOutcome: null as AiGenerateOutcome | null,
};

function deterministicSeed(input: AiGenerateInput): string {
  return JSON.stringify({
    wid: input.workspaceId,
    pid: input.promptTemplateId,
    sv: input.schemaVersion,
    seq: input.attemptNumber,
  });
}

function tokenEstimate(promptChars: number): number {
  return Math.max(1, Math.ceil(promptChars / 4));
}

function rawJsonFromSeed(seed: string): string {
  // Deterministic pseudo-JSON without external RNG — stable per seed.
  const hash = Array.from(seed).reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 0);
  return JSON.stringify({
    schemaVersion: 1,
    blueprintId: `bp_${hash.toString(16)}`,
    questions: [
      {
        id: `q_${hash.toString(16)}`,
        type: 'single_select',
        stem: 'Fixture stem — derived from prompt template + workspace.',
        options: [
          { id: 'a', text: 'Opsi A' },
          { id: 'b', text: 'Opsi B' },
          { id: 'c', text: 'Opsi C' },
        ],
        answerKey: { optionId: 'a' },
        explanation: 'Fixture explanation.',
      },
    ],
    marker: seed,
  });
}

export class MockAiAdapter implements ProductAiAdapter {
  public readonly meta: AiAdapterMeta = {
    driver: 'mock',
    providerModelId: 'mock-fixture-v1',
  };

  async generate(input: AiGenerateInput): Promise<AiGenerateResult> {
    if (mockDriverSwitches.forcedOutcome) {
      return { ok: true, value: mockDriverSwitches.forcedOutcome };
    }
    if (mockDriverSwitches.rateLimited) {
      const outcome: AiGenerateOutcome = {
        kind: 'rate_limited',
        providerModelId: this.meta.providerModelId,
        retryAfterMs: 1_000,
        redactedReasonFingerprint: 'fingerprint:[redacted]',
      };
      return { ok: true, value: outcome };
    }
    if (mockDriverSwitches.refused) {
      const outcome: AiGenerateOutcome = {
        kind: 'refused',
        providerModelId: this.meta.providerModelId,
        redactedReasonFingerprint: 'fingerprint:[redacted]',
      };
      return { ok: true, value: outcome };
    }
    if (mockDriverSwitches.schemaInvalid) {
      const outcome: AiGenerateOutcome = {
        kind: 'schema_invalid',
        providerModelId: this.meta.providerModelId,
        redactedResponseFingerprint: 'fingerprint:[redacted]',
        reason: 'parse_error',
        responseText: null,
      };
      return { ok: true, value: outcome };
    }

    const fixtureBuilder = REGISTRY.fixtures.get(input.promptTemplateId);
    const seed = deterministicSeed(input);
    if (fixtureBuilder) {
      // Test path: fixture builder can validate the exact requested schemaVersion.
      const built = fixtureBuilder(input);
      const payload = { ...built.payload, marker: seed };
      return {
        ok: true,
        value: {
          kind: 'succeeded',
          promptTemplateId: input.promptTemplateId,
          requestTokensEstimate: tokenEstimate(input.prompt.length),
          responseText: JSON.stringify(payload),
          providerModelId: this.meta.providerModelId,
          providerRequestId: `mock_${input.promptTemplateId}_${input.schemaVersion}`,
        },
      };
    }

    return {
      ok: true,
      value: {
        kind: 'succeeded',
        promptTemplateId: input.promptTemplateId,
        requestTokensEstimate: tokenEstimate(input.prompt.length),
        responseText: rawJsonFromSeed(seed),
        providerModelId: this.meta.providerModelId,
        providerRequestId: `mock_${seed}`,
      },
    };
  }
}
