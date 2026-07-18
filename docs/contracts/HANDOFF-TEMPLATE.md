# Task Handoff Template

```md
# Handoff — <TASK-ID>: <title>

Repository: Frontend-Lembar | Backend-Lembar
Branch/commit: ...
Status: READY_FOR_OWNER_REVIEW

## Outcome

Satu paragraf: perilaku pengguna/sistem yang sekarang bekerja.

## Scope delivered

- ...

## Explicitly not delivered

- ...

## Changed

- `path`: alasan dan perilaku.

## Contract impact

- OpenAPI version/commit:
- Additive/breaking/no change:
- Consumer action required:

## Security/privacy impact

- Data/secrets/permissions affected:
- Tests/evidence:

## Evidence

- `<exact command>` → result
- Manual/e2e scenario → result

## Decisions and assumptions

- Decision ID or reversible local assumption.

## Known limitations

- ...

## Owner review checklist

- [ ] Scope matches task
- [ ] Acceptance evidence sufficient
- [ ] No unrelated change
- [ ] Contract/security concerns resolved
- [ ] Accept or request correction

STOP. Do not begin another task until owner sends `START <TASK-ID>`.
```

`READY_FOR_OWNER_REVIEW` bukan `COMPLETED`. Hanya owner dapat menandai `ACCEPTED`.
