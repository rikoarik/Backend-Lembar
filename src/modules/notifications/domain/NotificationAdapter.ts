import { randomUUID } from 'node:crypto';

export interface NotificationRecipient {
  kind: 'email' | 'sms';
  value: string;
}

export interface NotificationSendInput {
  templateKey: string;
  locale: string;
  recipient: NotificationRecipient;
  payload: Record<string, unknown>;
  eventId: string;
  visibleAt?: Date;
}

export interface NotificationSendResult {
  id: string;
  status: 'dispatched' | 'duplicate' | 'rejected';
}

export interface NotificationAdapter {
  send(input: NotificationSendInput): Promise<NotificationSendResult>;
}

export interface MemorySendRecord {
  outboxId: string;
  templateKey: string;
  locale: string;
  recipientFingerprint: string;
  payloadHash: string;
  subjectHash: string;
  sentAt: string;
}

export class MemoryNotificationAdapter implements NotificationAdapter {
  private readonly records: MemorySendRecord[] = [];

  async send(input: NotificationSendInput): Promise<NotificationSendResult> {
    const id = cryptoRandomId();
    const record: MemorySendRecord = {
      outboxId: id,
      templateKey: input.templateKey,
      locale: input.locale,
      recipientFingerprint: 'redacted',
      payloadHash: 'pending',
      subjectHash: 'pending',
      sentAt: new Date().toISOString(),
    };
    this.records.push(record);
    return { id, status: 'dispatched' };
  }

  recordsSnapshot(): readonly MemorySendRecord[] {
    return [...this.records];
  }
}

function cryptoRandomId(): string {
  return randomUUID();
}

/**
 * Canonicalize a JSON payload so two semantically equal objects produce the same string.
 * Sorts object keys recursively. Arrays preserve order. `undefined` values are dropped.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(toCanonical(value));
}

function toCanonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toCanonical);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    out[key] = toCanonical(v);
  }
  return out;
}
