/**
 * Job handler contract for worker execution.
 *
 * Each handler processes one job kind. The worker orchestrator routes claimed jobs
 * to the appropriate handler based on the job's kind.
 */
import type { JobKind } from '../persistence/schema.js';

export interface JobContext {
  jobId: string;
  workspaceId: string;
  actorId: string;
  attempt: number;
  payload: Record<string, unknown>;
  signal: AbortSignal;
}

export interface JobResult {
  status: 'success' | 'failure' | 'partial';
  output?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface JobHandler {
  readonly kind: JobKind;
  handle(context: JobContext): Promise<JobResult>;
}

export interface JobHandlerRegistry {
  register(handler: JobHandler): void;
  get(kind: JobKind): JobHandler | undefined;
  has(kind: JobKind): boolean;
  list(): JobKind[];
}

export class DefaultJobHandlerRegistry implements JobHandlerRegistry {
  private readonly handlers = new Map<JobKind, JobHandler>();

  register(handler: JobHandler): void {
    if (this.handlers.has(handler.kind)) {
      throw new Error(`Handler already registered for kind: ${handler.kind}`);
    }
    this.handlers.set(handler.kind, handler);
  }

  get(kind: JobKind): JobHandler | undefined {
    return this.handlers.get(kind);
  }

  has(kind: JobKind): boolean {
    return this.handlers.has(kind);
  }

  list(): JobKind[] {
    return Array.from(this.handlers.keys());
  }
}
