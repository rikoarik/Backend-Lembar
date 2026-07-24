/**
 * B6-04 — Metrics collector.
 *
 * Tracks request count, latency samples (for p95), and queue depth.
 * Lightweight in-process telemetry — no external dependencies.
 */

export class MetricsCollector {
  private requestCount = 0;
  private latencySamples: number[] = [];
  private _queueDepth = 0;

  recordRequest(latencyMs: number): void {
    this.requestCount++;
    this.latencySamples.push(latencyMs);
    // Keep last 1000 samples to bound memory
    if (this.latencySamples.length > 1000) {
      this.latencySamples.shift();
    }
  }

  setQueueDepth(depth: number): void {
    this._queueDepth = depth;
  }

  incrementQueueDepth(): void {
    this._queueDepth++;
  }

  decrementQueueDepth(): void {
    if (this._queueDepth > 0) this._queueDepth--;
  }

  getP95Ms(): number {
    if (this.latencySamples.length === 0) return 0;
    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[Math.max(0, idx)] ?? 0;
  }

  getSnapshot(): { requestCount: number; latencyP95Ms: number; queueDepth: number } {
    return {
      requestCount: this.requestCount,
      latencyP95Ms: this.getP95Ms(),
      queueDepth: this._queueDepth,
    };
  }

  reset(): void {
    this.requestCount = 0;
    this.latencySamples = [];
    this._queueDepth = 0;
  }
}
