/**
 * B3-05 — Tests for EvalHarness.
 *
 * Verifies:
 *  - eval passes with mock adapter
 *  - latency threshold enforced
 *  - low-quality responses rejected
 *  - cost estimation
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { MockAiAdapter, clearMockFixtures, mockDriverSwitches } from '../../../src/infrastructure/ai/adapters/mock/MockAiAdapter.js';
import { EvalHarness, DEFAULT_THRESHOLDS, type EvalCase } from '../../../src/infrastructure/ai/eval/EvalHarness.js';

const WORKSPACE_ID = 'ws-eval-001';

function makeMockAdapter(): MockAiAdapter {
  return new MockAiAdapter();
}

function makeValidCase(label = 'case-1'): EvalCase {
  return {
    label,
    promptTemplateId: 'question-gen-v1',
    schemaVersion: 1,
    prompt: `Generate 5 questions about photosynthesis for grade 7.`,
    signals: { topic: 'photosynthesis', grade: 7 },
    validate: (text) => {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return { ok: true };
        return { ok: false, reason: 'not an object' };
      } catch {
        return { ok: false, reason: 'not valid JSON' };
      }
    },
  };
}

describe('EvalHarness', () => {
  beforeEach(() => {
    clearMockFixtures();
    mockDriverSwitches.rateLimited = false;
    mockDriverSwitches.refused = false;
    mockDriverSwitches.schemaInvalid = false;
    mockDriverSwitches.forcedOutcome = null;
  });

  it('eval passes with mock adapter — valid cases all succeed', async () => {
    const adapter = makeMockAdapter();
    const harness = new EvalHarness(adapter, DEFAULT_THRESHOLDS);

    const cases: EvalCase[] = [
      makeValidCase('case-1'),
      makeValidCase('case-2'),
      makeValidCase('case-3'),
    ];

    const report = await harness.run(cases, WORKSPACE_ID);

    expect(report.adapter.driver).toBe('mock');
    expect(report.totalCases).toBe(3);
    expect(report.passedCases).toBe(3);
    expect(report.failedCases).toBe(0);
    expect(report.passRate).toBe(1);
    expect(report.passed).toBe(true);
    expect(report.violations).toHaveLength(0);
  });

  it('latency threshold enforced — slow clock triggers p95 violation', async () => {
    const adapter = makeMockAdapter();
    // Simulate 15000ms latency by advancing clock
    let tick = 0;
    const slowClock = () => {
      tick += 15_000;
      return tick;
    };
    const harness = new EvalHarness(adapter, DEFAULT_THRESHOLDS, slowClock);

    const cases = [makeValidCase('slow-case')];
    const report = await harness.run(cases, WORKSPACE_ID);

    // p95 will be 15000ms which exceeds the default 10000ms threshold
    expect(report.passed).toBe(false);
    expect(report.violations.some((v) => v.includes('p95_latency'))).toBe(true);
  });

  it('low-quality responses rejected — validation failure marks case failed', async () => {
    const adapter = makeMockAdapter();
    const harness = new EvalHarness(adapter, DEFAULT_THRESHOLDS);

    const strictCase: EvalCase = {
      ...makeValidCase('strict'),
      validate: (_text) => ({ ok: false, reason: 'missing required field: questions' }),
    };

    const report = await harness.run([strictCase], WORKSPACE_ID);

    expect(report.passedCases).toBe(0);
    expect(report.failedCases).toBe(1);
    const c0 = report.cases[0]!;
    expect(c0.passed).toBe(false);
    expect(c0.failReason).toContain('validation_failed');
    expect(c0.failReason).toContain('missing required field: questions');
  });

  it('rate_limited adapter outcome marks case failed', async () => {
    const adapter = makeMockAdapter();
    mockDriverSwitches.rateLimited = true;

    const harness = new EvalHarness(adapter, DEFAULT_THRESHOLDS);
    const report = await harness.run([makeValidCase()], WORKSPACE_ID);

    expect(report.passedCases).toBe(0);
    expect(report.cases[0]!.outcomeKind).toBe('rate_limited');
    expect(report.cases[0]!.failReason).toContain('adapter_outcome');
  });

  it('refused adapter outcome marks case failed', async () => {
    const adapter = makeMockAdapter();
    mockDriverSwitches.refused = true;

    const harness = new EvalHarness(adapter, DEFAULT_THRESHOLDS);
    const report = await harness.run([makeValidCase()], WORKSPACE_ID);

    expect(report.passedCases).toBe(0);
    expect(report.cases[0]!.outcomeKind).toBe('refused');
  });

  it('pass rate threshold enforced — 0% pass with minPassRate=0.8 fails', async () => {
    const adapter = makeMockAdapter();
    mockDriverSwitches.refused = true;

    const harness = new EvalHarness(adapter, DEFAULT_THRESHOLDS);
    const report = await harness.run(
      [makeValidCase('a'), makeValidCase('b'), makeValidCase('c')],
      WORKSPACE_ID,
    );

    expect(report.passed).toBe(false);
    expect(report.violations.some((v) => v.includes('pass_rate'))).toBe(true);
  });

  it('cost estimation — reports estimated cost based on token usage', async () => {
    const adapter = makeMockAdapter();
    const harness = new EvalHarness(adapter, {
      ...DEFAULT_THRESHOLDS,
      costPer1kTokensUsd: 0.01,
      maxTotalCostUsd: 100,
    });

    const cases = [makeValidCase('a'), makeValidCase('b')];
    const report = await harness.run(cases, WORKSPACE_ID);

    expect(report.estimatedTotalTokens).toBeGreaterThanOrEqual(0);
    expect(report.estimatedTotalCostUsd).toBeGreaterThanOrEqual(0);
    expect(typeof report.estimatedTotalCostUsd).toBe('number');
  });

  it('prompt fingerprint stored — never raw prompt', async () => {
    const adapter = makeMockAdapter();
    const harness = new EvalHarness(adapter, DEFAULT_THRESHOLDS);

    const report = await harness.run([makeValidCase()], WORKSPACE_ID);

    const caseResult = report.cases[0]!;
    // Fingerprint is 16 hex chars, not the raw prompt
    expect(caseResult.promptFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(caseResult.promptFingerprint).not.toContain('Generate');
  });

  it('report includes latency stats', async () => {
    const adapter = makeMockAdapter();
    const harness = new EvalHarness(adapter, DEFAULT_THRESHOLDS);

    const report = await harness.run(
      [makeValidCase('a'), makeValidCase('b'), makeValidCase('c')],
      WORKSPACE_ID,
    );

    expect(typeof report.latencyMs.min).toBe('number');
    expect(typeof report.latencyMs.max).toBe('number');
    expect(typeof report.latencyMs.avg).toBe('number');
    expect(typeof report.latencyMs.p95).toBe('number');
    expect(report.latencyMs.min).toBeLessThanOrEqual(report.latencyMs.max);
  });

  it('empty cases array returns trivially passing report', async () => {
    const adapter = makeMockAdapter();
    const harness = new EvalHarness(adapter, DEFAULT_THRESHOLDS);

    const report = await harness.run([], WORKSPACE_ID);

    expect(report.totalCases).toBe(0);
    expect(report.passRate).toBe(0);
    // No violations since there are no cases to violate
    expect(report.passed).toBe(true);
  });
});
