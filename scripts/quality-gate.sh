#!/usr/bin/env bash
# Quality gate for Backend-Lembar — the exact gate sequence AGENTS.md
# "Quality gates" requires, in one place so CI and a human run the same thing.
#
# Used by:
#   .github/workflows/deploy-backend.yml  (job `gate`, blocks job `deploy`)
#   .github/workflows/quality-gate.yml    (pull requests + non-dev branches)
#
# Steps, in order:
#   1. install       pnpm install --frozen-lockfile
#   2. typecheck     pnpm typecheck
#   3. lint          pnpm lint
#   4. format:check  pnpm format:check
#   5. test          pnpm test                  (build + unit/integration)
#   6. test:db       pnpm test:db               (compose.test.yaml Postgres)
#   7. openapi       pnpm openapi:validate + pnpm openapi:breaking
#   8. secret:scan   pnpm secret:scan
#
# Fail-fast by default: the first failing step stops the run, so a red gate
# reports the cheapest actionable failure first. Set GATE_CONTINUE_ON_FAIL=1 to
# run every step anyway (useful when triaging a tree with several problems).
#
# `pnpm install --frozen-lockfile` is step 1 here rather than a separate
# workflow step so that a local `bash scripts/quality-gate.sh` is exactly what
# CI runs.
set -uo pipefail

CONTINUE="${GATE_CONTINUE_ON_FAIL:-0}"
FAILED=()
RAN=()

step() {
  local name="$1"
  shift
  printf '\n=== gate: %s ===\n' "$name"
  printf '+ %s\n' "$*"
  if "$@"; then
    RAN+=("PASS  $name")
    return 0
  fi
  RAN+=("FAIL  $name")
  FAILED+=("$name")
  if [ "$CONTINUE" != "1" ]; then
    printf '\n=== gate summary ===\n'
    printf '%s\n' "${RAN[@]}"
    printf '\ngate FAILED at step: %s\n' "$name"
    exit 1
  fi
  return 0
}

step install      pnpm install --frozen-lockfile
step typecheck    pnpm typecheck
step lint         pnpm lint
step format:check pnpm format:check
step test         pnpm test
# test:db brings up compose.test.yaml's ephemeral Postgres on 127.0.0.1:55432.
# It runs in CI: the self-hosted runner has docker, and this is the same
# Postgres the AGENTS.md "PostgreSQL integration" gate names. See the workflow
# comment for the runner requirement.
step test:db      pnpm test:db
step openapi      bash -c 'pnpm openapi:validate && pnpm openapi:breaking'
step secret:scan  pnpm secret:scan

printf '\n=== gate summary ===\n'
printf '%s\n' "${RAN[@]}"

if [ "${#FAILED[@]}" -gt 0 ]; then
  printf '\ngate FAILED: %s\n' "${FAILED[*]}"
  exit 1
fi

printf '\ngate PASSED — all steps green.\n'
