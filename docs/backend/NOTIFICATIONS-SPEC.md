# Transactional Notifications

Email provider remains D-007. Notifications are transactional and minimal; marketing requires
separate consent and system.

## P0/P1 notification types

| Event | Recipient | Priority | Sensitive content policy |
| --- | --- | --- | --- |
| Verify account | account owner | P0 if verification used | purpose-bound token only |
| Password/account recovery | account owner | P0 | generic request context |
| Password/security change | account owner | P0 | no credential/session value |
| School invitation | invited teacher | P1 | school display name + token |
| Invitation revoked/role changed | affected member | P1 | metadata only |
| Generation/export completed | opt-in owner | Later | no question/source text |
| Usage threshold | owner/admin | Paid/P1 | aggregate counts only |
| Subscription state | billing contact | Paid | no payment instrument |

## Token-link security

- Random high entropy, single-use where appropriate, short-lived, purpose-bound.
- Store hash, not plaintext.
- Public link includes token only in initial URL; application avoids third-party resources and
  strips/referrer-protects token.
- Rate limit and enumeration-safe response.
- Reissuing rotates old token.
- Email logs/events never contain full token or URL.

## Delivery model

- Domain transaction emits outbox event.
- Notification worker resolves current recipient/permission and approved template/version.
- Provider adapter sends with idempotency key where supported.
- Delivery status stores provider message ID and category, not rendered secret/body by default.
- Bounce/complaint/unsubscribe policy handled according to message type.

## Template requirements

- Bahasa Indonesia default; plain text and minimal HTML.
- Brand lockup/wordmark with accessible alt.
- Clear action, expiry, and “abaikan jika bukan Anda” where appropriate.
- No tracking pixel in security/activation messages by default.
- No assessment content, source filename, answer key, prompt, or private share token outside
  intended one-time link.
- Every template preview uses synthetic data.

## Reliability

- Provider transient retry with jitter and cap.
- Permanent invalid recipient is terminal, visible through safe product state where needed.
- Auth/invite flows provide resend/alternate support without leaking existence.
- Provider outage must not roll back completed product transaction.
- Alert on sustained failure/bounce anomaly.

## Acceptance D-007

- sender domain/authentication and deliverability setup;
- region/data-processing review;
- template preview and localization;
- token redaction and no third-party leak;
- duplicate/out-of-order event test;
- sandbox/local provider or capture sink without production credentials;
- unsubscribe distinction for transactional vs marketing.

