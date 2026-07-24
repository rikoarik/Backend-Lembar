/**
 * B6-04 — Ops metrics & lead capture: domain types.
 */

export interface MetricsSnapshot {
  requestCount: number;
  latencyP95Ms: number;
  queueDepth: number;
  capturedAt: string;
}

export interface LeadCaptureInput {
  name: string;
  email: string;
  school: string;
  role: string;
}

export interface LeadRecord {
  id: string;
  name: string;
  email: string;
  school: string;
  role: string;
  capturedAt: string;
}
