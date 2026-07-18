# Shared State Machines

Backend persists and validates state transitions. Frontend renders the state and available
actions; it never invents a transition.

## Assessment

```text
draft_config -> generating -> review -> final
     |              |           |       |
     +-> archived   +-> failed  +-> archived
                                final -> new draft version (not mutation)
```

Canonical states:

- `draft`: configuration or generated content remains editable.
- `generating`: current generation job active; existing safe draft may remain viewable.
- `review`: question set exists and requires teacher review.
- `final`: immutable assessment version.
- `archived`: hidden from normal active lists; retention policy applies.

Generation job failure is not automatically an assessment terminal deletion. Assessment may
return/remain draft with actionable failure.

Allowed commands:

| State | Commands |
| --- | --- |
| draft | update config, attach source, start generation, archive |
| generating | read, request cancel if supported |
| review | edit/review/regenerate/delete question, finalize, archive |
| final | export, share, duplicate/new draft version, archive |
| archived | restore if policy, purge request |

## Assessment version and question review

Assessment version: `editable -> final`. Final is immutable. Question review states:

`unreviewed -> accepted|edited|rejected`; any edited/regenerated replacement becomes
`unreviewed` or `needs_attention` according to quality rule.

Finalize requires all included questions in an allowed resolved state.

## Source

```text
created -> uploading -> uploaded -> processing -> ready
                         |             |          |
                         +-> failed    +-> failed +-> deleting -> deleted
```

- Upload expiry before complete can become `expired`.
- `failed` carries stable reason and retryability.
- `ready` source can be disabled/deleting; new jobs cannot claim it.
- Delete workflow removes derived data and ends `deleted`; history/provenance follows policy.

## Job

Detailed in backend spec. Public canonical:

`queued`, `running`, `retry_wait`, `succeeded`, `partially_succeeded`, `failed`,
`cancellation_requested`, `cancelled`.

Frontend legacy stages such as preparing/generating/validating are `stage`, not status.

## Export artifact

```text
requested -> rendering -> ready -> expired
                  |          |
                  +-> failed +-> deleted
```

Retry creates/reuses job for the same deterministic artifact key. `ready` artifact is immutable.

## Share link

`active -> expired|revoked`. Revoked/expired never becomes active again; create a new token.

Viewer availability additionally depends on artifact/package existence and owner/workspace
policy, but response must not reveal which internal condition failed.

## Invitation and membership

Invitation: `pending -> accepted|expired|revoked`. Token is single-use.  
Membership: `active -> suspended|revoked`; suspended may return active via explicit admin action,
revoked requires new invitation/policy.

## Subscription and entitlement

Subscription provider-neutral:

`none -> trialing|active -> past_due|cancel_scheduled|paused -> grace|cancelled|active -> expired`.

Effective entitlement is calculated separately and versioned; provider webhook cannot bypass
policy or security suspension.

## Curriculum/catalog

`draft -> reviewed -> published -> archived`. Published content is immutable by version;
correction creates a new version/replacement link. Archived remains resolvable for history.

## Marketing CMS

`draft -> published -> superseded`.

- Draft save increments revision and can conflict.
- Publish atomically sets the public pointer to an immutable version.
- A later publish supersedes, but does not mutate, the previous version.
- Unpublish clears the public pointer through an audited command.
- Restore copies a selected historical version into a new draft, then follows normal publish.
- Public queries resolve only the current published pointer.

## Transition contract

Every command:

- verifies current version/state/tenant/permission;
- is idempotent where retryable;
- returns `STATE_CONFLICT` plus safe current state when invalid;
- writes audit/domain event where required;
- never skips required review/finalization due to client request;
- has integration tests for allowed and forbidden transitions.
