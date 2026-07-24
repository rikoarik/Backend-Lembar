/**
 * B6-04 — Lead capture service.
 *
 * Validates, rate-limits, and stores leads.
 * Rate limit: max 3 submissions per email per hour.
 */
import { randomUUID } from 'node:crypto';

import type { LeadCaptureInput, LeadRecord } from '../domain/types.js';

export class LeadTooFrequentError extends Error {
  constructor(email: string) {
    super(`Too many lead submissions for ${email}. Try again later.`);
    this.name = 'LeadTooFrequentError';
  }
}

export class LeadValidationError extends Error {
  readonly fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super('Lead validation failed');
    this.name = 'LeadValidationError';
    this.fields = fields;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PER_HOUR = 3;

export interface LeadStore {
  save(lead: LeadRecord): Promise<void>;
  countByEmailSince(email: string, since: Date): Promise<number>;
  list(): Promise<LeadRecord[]>;
}

export class InMemoryLeadStore implements LeadStore {
  private leads: LeadRecord[] = [];

  async save(lead: LeadRecord): Promise<void> {
    this.leads.push(lead);
  }

  async countByEmailSince(email: string, since: Date): Promise<number> {
    return this.leads.filter(
      (l) => l.email === email && new Date(l.capturedAt) >= since,
    ).length;
  }

  async list(): Promise<LeadRecord[]> {
    return [...this.leads];
  }
}

export class LeadCaptureService {
  constructor(
    private readonly store: LeadStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private validate(input: LeadCaptureInput): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!input.name || input.name.trim().length < 2) {
      errors['name'] = 'Name must be at least 2 characters.';
    }
    if (!input.email || !EMAIL_RE.test(input.email)) {
      errors['email'] = 'Valid email required.';
    }
    if (!input.school || input.school.trim().length < 2) {
      errors['school'] = 'School name must be at least 2 characters.';
    }
    if (!input.role || input.role.trim().length < 2) {
      errors['role'] = 'Role must be at least 2 characters.';
    }
    return errors;
  }

  async capture(input: LeadCaptureInput): Promise<LeadRecord> {
    // Validate
    const errors = this.validate(input);
    if (Object.keys(errors).length > 0) {
      throw new LeadValidationError(errors);
    }

    // Rate limit: max 3 per email per hour
    const now = this.clock();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const recentCount = await this.store.countByEmailSince(input.email, oneHourAgo);
    if (recentCount >= MAX_PER_HOUR) {
      throw new LeadTooFrequentError(input.email);
    }

    const lead: LeadRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      school: input.school.trim(),
      role: input.role.trim(),
      capturedAt: now.toISOString(),
    };

    await this.store.save(lead);
    return lead;
  }
}
