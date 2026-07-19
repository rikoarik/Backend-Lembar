import {
  canonicalize,
  type NotificationAdapter,
  type NotificationSendInput,
} from './NotificationAdapter.js';
import { NotificationRepository, sha256 } from '../persistence/NotificationRepository.js';

export interface NotificationDispatchResult {
  status: 'dispatched' | 'duplicate' | 'rejected';
  outboxId: string | null;
  locale: string;
  redactedRecipient: string;
  subjectHash: string;
}

export interface NotificationServiceDeps {
  adapter: NotificationAdapter;
  repository: NotificationRepository;
  clock?: () => Date;
}

export class NotificationService {
  private readonly clock: () => Date;

  constructor(private readonly deps: NotificationServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async dispatch(input: NotificationSendInput): Promise<NotificationDispatchResult> {
    const locale = input.locale || 'id-ID';
    const recipientHash = hashRecipient(input.recipient);
    const payloadHash = sha256(canonicalize(input.payload));

    const template = await this.deps.repository.findTemplate(input.templateKey, locale);
    if (!template) {
      return {
        status: 'rejected',
        outboxId: null,
        locale,
        redactedRecipient: redactRecipient(input.recipient.kind),
        subjectHash: '',
      };
    }

    return this.deps.repository.transaction(async (tx) => {
      const duplicate = await tx.hasSentDedupe(input.templateKey, recipientHash, payloadHash);
      if (duplicate) {
        return {
          status: 'duplicate',
          outboxId: null,
          locale: template.locale,
          redactedRecipient: redactRecipient(input.recipient.kind),
          subjectHash: sha256(template.subject).slice(0, 12),
        } satisfies NotificationDispatchResult;
      }

      const outbox = await tx.createOutbox({
        eventId: input.eventId,
        templateKey: input.templateKey,
        locale: template.locale,
        recipientHash,
        recipientKind: input.recipient.kind,
        payloadHash,
        payload: input.payload,
        visibleAt: input.visibleAt ?? null,
      });

      const subjectRendered = renderTemplate(template.subject, input.payload);
      const bodyRendered = renderTemplate(template.bodyText, input.payload);
      const startedAt = this.clock().getTime();
      const adapterResult = await this.deps.adapter.send({
        ...input,
        locale: template.locale,
      });
      const latencyMs = Math.max(0, this.clock().getTime() - startedAt);

      await tx.insertAudit({
        outboxId: outbox.id,
        status: adapterResult.status === 'rejected' ? 'failed' : 'dispatched',
        redactedRecipient: redactRecipient(input.recipient.kind),
        redactedSubjectHash: sha256(subjectRendered).slice(0, 12),
        latencyMs,
      });

      await tx.markOutboxSent(outbox.id);

      void bodyRendered;

      return {
        status: adapterResult.status,
        outboxId: outbox.id,
        locale: template.locale,
        redactedRecipient: redactRecipient(input.recipient.kind),
        subjectHash: sha256(subjectRendered).slice(0, 12),
      } satisfies NotificationDispatchResult;
    });
  }
}

export function hashRecipient(recipient: { kind: 'email' | 'sms'; value: string }): string {
  return sha256(`${recipient.kind}:${recipient.value}`);
}

export function redactRecipient(kind: 'email' | 'sms'): string {
  return kind === 'email' ? 'email:***@example.test' : 'sms:***';
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function renderTemplate(template: string, payload: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = payload[key];
    if (value === undefined || value === null) return `{{ ${key} }}`;
    return String(value);
  });
}
