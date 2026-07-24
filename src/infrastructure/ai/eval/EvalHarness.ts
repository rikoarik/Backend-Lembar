/**
 * B3-05 — Pilot eval and model route gate.
 *
 * Eval harness that:
 *  - Runs test prompts through the AI adapter
 *  - Measures latency per call
 *  - Estimates token cost
 *  - Enforces quality thresholds (min score, max latency, max cost)
 *  - Rejects low-quality responses
 *
 * This harness is adapter-agnostic; pass any ProductAiAdapter (mock or real).
 * The harness never logs prompt content or response bodies — only fingerprints.
 */
import { createHash } from 'node:crypto';

import type { AiGenerateInput, AiGenerateOutcome, ProductAiAdapter } from '../domain/ProductAiAdapter.js';

// ---- Types ----

export interface EvalCase {
  /** Human-readable label for the eval case. */
  label: string;
  /** Prompt template ID to exercise. */
  promptTemplateId: string;
  /** Schema version for this prompt. */
  schemaVersion: number;
  /** Prompt text. Never logged — only fingerprint is stored. */
  prompt: string;
  /** Signals passed to the adapter. */
  signals: Record<string, string | number | boolean>;
  /**
   * Validator run on the response text.
   * Returns { ok: true } on pass or { ok: false; reason: string } on fail.
   */
  validate: (responseText: string) => { ok: true } | { ok: false; reason: string };
}

export interface EvalThresholds {
  /** Maximum acceptable p95 latency in ms across all cases. */
  maxLatencyP95Ms: number;
  /** Maximum acceptable average latency in ms. */
  maxLatencyAvgMs: number;
  /** Minimum fraction of cases that must pass (0–1). */
  minPassRate: number;
  /** Estimated cost per 1000 tokens in USD. Used for cost report only. */
  costPer1kTokensUsd: number;
  /** Maximum acceptable estimated total cost in USD for the full run. */
  maxTotalCostUsd: number;
}

export const DEFAULT_THRESHOLDS: EvalThresholds = {
  maxLatencyP95Ms: 10_000,
  maxLatencyAvgMs: 5_000,
  minPassRate: 0.8,
  costPer1kTokensUsd: 0.002,
  maxTotalCostUsd: 1.0,
};

export interface EvalCaseResult {
  label: string;
  promptTemplateId: string;
  passed: boolean;
  /** Rejection reason if passed=false. */
  failReason: string | null;
  latencyMs: number;
  requestTokensEstimate: number;
  /** Fingerprint of prompt — safe to log. */
  promptFingerprint: string;
  /** Kind returned by the adapter. */
  outcomeKind: AiGenerateOutcome['kind'];
}

export interface EvalReport {
  adapter: { driver: string; providerModelId: string };
  thresholds: EvalThresholds;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  latencyMs: { min: number; max: number; avg: number; p95: number };
  estimatedTotalTokens: number;
  estimatedTotalCostUsd: number;
  /** Whether the run met all thresholds. */
  passed: boolean;
  /** List of threshold violations if passed=false. */
  violations: string[];
  cases: EvalCaseResult[];
}

// ---- Helpers ----

function promptFingerprint(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return sorted[Math.max(0, idx)]!;
}

// ---- EvalHarness ----

export class EvalHarness {
  constructor(
    private readonly adapter: ProductAiAdapter,
    private readonly thresholds: EvalThresholds = DEFAULT_THRESHOLDS,
    private readonly clock: () => number = Date.now,
  ) {}

  async run(cases: EvalCase[], workspaceId = 'eval-workspace'): Promise<EvalReport> {
    const results: EvalCaseResult[] = [];

    for (const evalCase of cases) {
      const input: AiGenerateInput = {
        workspaceId,
        promptTemplateId: evalCase.promptTemplateId,
        schemaVersion: evalCase.schemaVersion,
        prompt: evalCase.prompt,
        contextWindowId: null,
        tokenEstimateHint: null,
        signals: evalCase.signals,
        attemptNumber: 0,
        maxSchemaRepairAttempts: 0,
      };

      const start = this.clock();
      const result = await this.adapter.generate(input);
      const latencyMs = this.clock() - start;
      const outcome = result.value;

      let passed = false;
      let failReason: string | null = null;
      let requestTokensEstimate = 0;

      if (outcome.kind === 'succeeded') {
        requestTokensEstimate = outcome.requestTokensEstimate;
        const validation = evalCase.validate(outcome.responseText);
        if (validation.ok) {
          passed = true;
        } else {
          failReason = `validation_failed: ${validation.reason}`;
        }
      } else {
        failReason = `adapter_outcome: ${outcome.kind}`;
      }

      results.push({
        label: evalCase.label,
        promptTemplateId: evalCase.promptTemplateId,
        passed,
        failReason,
        latencyMs,
        requestTokensEstimate,
        promptFingerprint: promptFingerprint(evalCase.prompt),
        outcomeKind: outcome.kind,
      });
    }

    return this.buildReport(results);
  }

  private buildReport(results: EvalCaseResult[]): EvalReport {
    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    const passRate = results.length > 0 ? passed / results.length : 0;

    const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
    const avgLatency =
      latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const p95Latency = percentile(latencies, 95);
    const minLatency = latencies.length > 0 ? (latencies[0] as number) : 0;
    const maxLatency = latencies.length > 0 ? (latencies[latencies.length - 1] as number) : 0;

    const totalTokens = results.reduce((sum, r) => sum + r.requestTokensEstimate, 0);
    const estimatedCost = (totalTokens / 1000) * this.thresholds.costPer1kTokensUsd;

    const violations: string[] = [];
    if (results.length > 0 && passRate < this.thresholds.minPassRate) {
      violations.push(
        `pass_rate ${(passRate * 100).toFixed(1)}% < required ${(this.thresholds.minPassRate * 100).toFixed(1)}%`,
      );
    }
    if (p95Latency > this.thresholds.maxLatencyP95Ms) {
      violations.push(
        `p95_latency ${p95Latency}ms > max ${this.thresholds.maxLatencyP95Ms}ms`,
      );
    }
    if (avgLatency > this.thresholds.maxLatencyAvgMs) {
      violations.push(
        `avg_latency ${avgLatency.toFixed(0)}ms > max ${this.thresholds.maxLatencyAvgMs}ms`,
      );
    }
    if (estimatedCost > this.thresholds.maxTotalCostUsd) {
      violations.push(
        `estimated_cost $${estimatedCost.toFixed(4)} > max $${this.thresholds.maxTotalCostUsd}`,
      );
    }

    return {
      adapter: {
        driver: this.adapter.meta.driver,
        providerModelId: this.adapter.meta.providerModelId,
      },
      thresholds: this.thresholds,
      totalCases: results.length,
      passedCases: passed,
      failedCases: failed,
      passRate,
      latencyMs: { min: minLatency, max: maxLatency, avg: avgLatency, p95: p95Latency },
      estimatedTotalTokens: totalTokens,
      estimatedTotalCostUsd: estimatedCost,
      passed: violations.length === 0,
      violations,
      cases: results,
    };
  }
}
