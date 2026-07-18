# Entitlement, Billing, and Quota

Pricing amounts and payment provider remain open. Domain model must support free, individual,
school pilot, manual grant, and future paid subscription without hard-coding vendor status.

## Separation of concerns

- `Plan`: marketed package/version.
- `Subscription`: commercial relationship/provider state.
- `Entitlement`: effective capabilities/limits at a time.
- `QuotaLedger`: immutable usage/reservation adjustment.
- `Seat`: active school membership counted by policy.

Access is computed from entitlement, not directly from payment webhook or frontend plan label.

## Entitlement examples

```text
assessment.generate
question.regenerate
source.pdf.upload
output.pdf
output.share
library.template
library.question_bank
school.member.manage
```

Limits can include question count per request, active source bytes/pages, generation allowance,
concurrency, artifact retention, share expiry, and seat cap. Exact numbers are plan version data.

## Effective entitlement precedence

1. security/legal suspension;
2. explicit workspace contract override;
3. active/grace subscription plan;
4. pilot/manual grant with expiry;
5. default free plan;
6. feature flag may narrow rollout but not silently increase billable promise.

All manual changes include reason, actor, expiry, and audit.

## Quota ledger

Append-only entries:

- `grant`
- `reserve`
- `commit`
- `release`
- `refund`
- `adjustment`
- `expire`

Each has workspace, period/bucket, units, unique reference, reason enum, source job/transaction,
actor/system, timestamp. Balance is derived/read-modeled; never edited in place.

## Generation lifecycle

1. Validate current entitlement and request max.
2. Reserve expected units in same transaction as job/outbox.
3. On usable success, commit reservation exactly once.
4. On terminal system failure/cancel before chargeable effect, release exactly once.
5. Partial result policy computes commit/release from accepted rule and states it in UI.
6. Retry/re-delivery uses original reservation/reference.

Manual question editing, review, reprint, and redownload do not consume generation allowance.
Targeted regeneration policy remains data-driven and documented before pricing.

## School pooled quota and seats

- School workspace owns pooled allowance.
- Teacher actions consume through workspace ledger with actor reference.
- Admin sees aggregate and policy-approved member usage, not question/source content.
- Seat count follows membership status and plan policy; pending invites may or may not reserve a
  seat but rule must be explicit.
- Removing user does not transfer/delete their authored workspace content automatically;
  ownership policy controls it.

## Subscription state

Provider-neutral states: `none`, `trialing`, `active`, `past_due`, `grace`, `paused`,
`cancel_scheduled`, `cancelled`, `expired`.

- Webhook is verified and idempotent.
- Store provider IDs/timestamps, not raw payment instrument.
- Out-of-order events handled by event time/version and reconciliation.
- Paid state does not directly overwrite entitlement without policy transition.
- Period renewal grants a new idempotent quota bucket.

## Downgrade/cancellation

Define before paid launch:

- when entitlement changes (immediate/end period/grace);
- treatment of unused allowance;
- existing sources/artifacts/share links;
- over-limit read vs create behavior;
- data export/deletion and retention;
- school seat overage resolution.

Prefer preserving read/download of owned data while blocking new costly actions, subject to
security/legal/retention.

## Payment security

- Use hosted/approved provider flow; backend never handles raw card data unless explicitly
  required and scoped.
- Verify signature against raw body and correct endpoint secret.
- Secret/request payload redaction.
- Checkout amount/plan derived server-side from accepted price catalog.
- Return URL is allowlisted.
- Refund/manual adjustment audited.
- Tax/invoice/renewal copy reviewed before launch.

## Tests

- double submit and duplicate worker delivery;
- concurrent reservations at last unit;
- failed/partial/cancel/retry paths;
- period renewal exactly once;
- out-of-order/duplicate webhook;
- expired manual grant;
- workspace switch/cross-tenant ledger attack;
- past-due/grace/downgrade;
- seat invitation/suspension/removal;
- no payment/secret data in logs.

