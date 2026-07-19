# B0-09 — Transactional notification provider spike (D-007)

## Status

`Accepted` for the B0-09 spike window. Production provider selection is **deferred** until a
provider-specific task lands with a real production secret slot.

## Context

The auth (B0-05) and curriculum (B1-04) modules eventually need to send transactional emails and
SMS messages — recovery codes, invitations, password resets. We have no accepted notification
provider yet (D-007 is open), and we must not leak PII or duplicate sends on caller retries.
This spike commits to a memory-backed adapter behind a stable `NotificationAdapter` boundary so:

1. The owning modules can wire send calls without picking a vendor.
2. The dedupe semantics are tested independent of vendor behaviour.
3. Migration to a real provider later is a one-file change (`adapters/.../memory.ts` →
   `adapters/.../sendgrid.ts` etc.).

## Decision

**D-007 — transactional at-least-once via outbox + memory adapter; production provider deferred
to a provider-specific task once production secret slot exists.**

### Locale strategy

- `id-ID` is the default and the **fallback** locale. Any request whose `(template_key, locale)`
  pair is missing falls back to `id-ID`.
- English is a parallel second locale (`en-US`). Two seeded templates ship in both locales.
- The HTTP surface and the audit surface expose the **resolved** locale, not the requested one.

### Dedupe boundary

- Outbox `event_id` is **unique** (caller-provided dedupe boundary).
- Outbox `(template_key, recipient_hash, payload_hash)` has a **partial unique index** restricted
  to `status = 'sent'` so the second identical dispatch returns `duplicate` and does not grow
  the audit table.
- `eventId` is intentionally **not** part of the duplicate-detection key — re-sending the same
  rendered bytes must short-circuit even if the caller rotates `eventId` between retries.
- `recipient_hash = sha256("email:" | value)` or `sha256("sms:" | value)` (full 64 hex chars).
- `payload_hash = sha256(canonical_json(payload))` (sorts object keys, drops `undefined`,
  preserves array order).

### Transactional emission

- `NotificationService.dispatch` runs the `eventId` insert, template lookup, adapter send, and
  audit insert inside one `db.transaction` callback.
- A caller-level `db.transaction` that wraps `dispatch` and rolls back leaves **no** outbox or
  audit row behind (covered by `test/modules/notifications/adapter.test.ts`).

### Adapter surface

```ts
interface NotificationAdapter {
  send(input: NotificationSendInput): Promise<{ id: string; status: 'dispatched' | 'duplicate' | 'rejected' }>;
}
```

The `memory` driver is the only allowed adapter here. The DB-level `adapter = 'memory'` CHECK
constraint blocks any accidental in-process injection of a different driver name.

### Async drain deferral

The dispatcher is **synchronous** and writes the audit row in the same transaction. A worker
process that drains `notification_outbox` rows on a schedule **belongs to a later B2-N task**.
The `notification_outbox` column shape is intentionally narrow (id / event_id / template_key /
locale / recipient_hash / recipient_kind / payload_hash / payload / status / attempt_count /
visible_at) so a future worker can lease and retry without a schema change.

### PII handling

- The full recipient string (`email`, `phone`) and the rendered subject/body **never** appear in
  logs or in the `notification_send_audit` row.
- The audit row stores `redacted_recipient` (`email:***@example.test` / `sms:***`) and
  `redacted_subject_hash` (`sha256(subject).slice(0, 12)`).
- Smoke scripts emit redacted JSON only.

## Rollout

1. Migration `0005_notification_outbox.sql` adds three tables (`notification_templates`,
   `notification_outbox`, `notification_send_audit`) and seeds two templates × two locales.
2. `src/modules/notifications/{domain,persistence,adapters/http}` is fully typed and isolated
   from auth/curriculum modules.
3. Four read-only HTTP routes under `/v1/notifications/*` are exposed for spike purposes
   (B1-03 will tighten auth/permission).
4. `pnpm notification:smoke` and `pnpm notification:smoke:duplicate` exercise the spike end to
   end against the disposable Postgres at `127.0.0.1:55443`.

## Deferred items

- Production provider (SendGrid / Twilio / AWS SES / Resend / etc.) — pick when a secret slot
  exists; wire as a new file under `src/modules/notifications/adapters/`.
- Async outbox drain worker — B2-N task.
- Per-tenant audit isolation filter — currently all rows surface to the same read endpoint;
  will tighten once B1-03 lands.
- Outbox retry/backoff policy — `attempt_count` exists but no automated retry yet.
- HTTP auth tightening for `/v1/notifications/dispatch` — currently a stub bearer mirror.
