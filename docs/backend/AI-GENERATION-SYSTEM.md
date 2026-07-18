# AI, Source Grounding & Evaluation System

## Purpose

AI creates reviewable assessment drafts from an approved configuration and source context.
It does not publish or finalize content, decide curriculum truth, or bypass teacher review.

## Provider boundary

- D-019 remains open until the product-runtime provider passes privacy, quality, latency, and
  cost review. OpenAI direct is the proposed baseline, not an implicit acceptance.
- Calls occur only in worker/backend through an internal adapter.
- A selected provider must support schema-constrained structured output or a validated parsing
  layer with equivalent failure handling.
- Model IDs and reasoning settings are runtime/model-registry configuration, never frontend code.
- Configure data storage behavior intentionally; do not rely on provider defaults.
- Do not infer product provider from Claude Code/Agent Orchestrator routing. A 9Router setup for
  coding agents is operationally separate from AI calls made by `lembar`.

Candidate OpenAI references if D-019 selects direct OpenAI:

- https://developers.openai.com/api/docs/guides/text
- https://developers.openai.com/api/docs/guides/structured-outputs
- https://developers.openai.com/api/docs/guides/migrate-to-responses

Realtime API is not part of this text/document generation workflow. “Latest information” comes
from versioned sources or explicitly approved retrieval, not low-latency audio transport.

## Pipeline

1. Validate configuration and entitlement.
2. Resolve immutable catalog/source versions.
3. Retrieve passages under workspace/source constraints.
4. Build a blueprint with coverage and difficulty targets.
5. Generate question batches with source references.
6. Parse/validate strict schema.
7. Run deterministic quality checks.
8. Optionally run model-assisted critic on higher-risk items.
9. Store draft, issues, usage, prompt/model version, and source links.
10. Present to teacher review.

## Source hierarchy

1. Versioned official curriculum outcomes/canonical catalog metadata.
2. Approved material/content available to the platform with clear rights/provenance.
3. Teacher-owned/uploaded PDF within that workspace.
4. Teacher focus and example question as style/intent input.
5. Web source only if future feature explicitly enabled with security/provenance controls.

Teacher example is not automatically factual ground truth. Document instructions are untrusted
content and cannot override system/developer policy.

## Retrieval contract

- Workspace filter is mandatory before semantic/text search.
- Return passage ID, source version, page/section, hash, and relevance metadata.
- `source_strict` forbids unsupported external facts except basic language scaffolding policy.
- Insufficient evidence results in fewer questions/clear failure, not hallucinated padding.
- Retrieval implementation (PostgreSQL FTS/pgvector/hosted) is decided by benchmark, not fashion.

## Versioned input

Each job records:

- prompt template version;
- JSON schema version;
- model route and snapshot/alias used;
- reasoning/temperature-like supported settings;
- curriculum and source versions;
- retrieval configuration;
- quality ruleset version;
- provider request ID and usage metadata where safe.

Do not store chain-of-thought. Store outputs, concise rationale requested by product, validation
evidence, and operational metadata.

## Blueprint schema minimum

- `id/sequence`.
- curriculum outcome/indicator reference.
- topic/material references.
- cognitive target.
- difficulty.
- question type.
- source requirements.
- learning intent.

## Question schema minimum

- `schemaVersion`.
- `questionType`.
- `stem`.
- structured `options` with stable IDs.
- `answerKey` by option ID, not position text.
- concise `explanation`.
- `difficulty` and cognitive metadata.
- blueprint reference.
- source references.
- flags/limitations when evidence is weak.

## Deterministic checks

- Required fields/schema and length limits.
- Answer option exists; exactly one correct for single-select.
- Options unique after normalization.
- No duplicate/near-duplicate stem within package.
- No leaked prompt/system/provider text.
- Basic unsafe/inappropriate content filters.
- Source reference exists and is authorized for workspace.
- Math/format rules where deterministic.
- Distribution matches blueprint within tolerance.

## Model-assisted checks

Use only after deterministic checks and evaluate independently:

- factual/key correctness;
- evidence supports stem and key;
- ambiguity;
- distractor quality;
- grade-level language;
- curriculum alignment;
- cultural/safety sensitivity.

An AI critic is not proof. High-risk subjects/items need human content review during pilot.

## Eval program

Dataset stratified by grade, subject, material type, assessment type, and difficulty. Include:

- gold questions/answers reviewed by educators;
- adversarial PDFs with prompt injection/noise;
- insufficient-source cases;
- tables, math, scans, mixed language;
- ambiguous/bad examples;
- regression cases from teacher reports.

Metrics:

- answer/key accuracy;
- source-supported rate;
- curriculum alignment;
- ambiguity and duplicate rate;
- schema success;
- teacher edit/regenerate/delete rate;
- latency and cost per final accepted question/package.

Release threshold is set per cohort in D-013. A new model goes offline eval → shadow comparison
→ limited canary → rollout. Do not auto-upgrade because a newer model name exists.

## Failure and fallback

- Timeout/rate limit/network: bounded retry with jitter and idempotency.
- Schema failure: constrained repair attempt with cap.
- Quality failure: regenerate affected item/batch, not entire package by default.
- Insufficient source: return actionable user state.
- Provider outage: queue/backoff; alternate model/provider only if pre-approved and evaluated.
- Persist neutral failure code; raw provider detail remains restricted logs.

## Cost controls

- Per-plan/question-count caps.
- Batch size and concurrency limits.
- Reservation before request, commit after accepted result.
- Usage/cost metadata correlated to job without logging content.
- Model routing changes require eval and cost review.
- No “unlimited” product promise.
