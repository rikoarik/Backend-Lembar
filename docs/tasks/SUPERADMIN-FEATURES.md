# Superadmin (Ops) Feature Tasks — Backend + Data Seed

Status: draft
Created: 2026-07-25
Owner: Riko

## Analisis

Panel superadmin (`/ops`) punya 11 menu di sidebar. Dari FE mock + BE existing, ini mapping status realitas:

| Fitur FE | BE Endpoint | FE Data | Status |
|---|---|---|---|
| Ringkasan /ops | `GET /v1/metrics` | KPI hardcoded | ✅ Partial |
| Akun /ops/accounts | `GET /v1/admin/accounts` (superadmin token) | MOCK | ⚠️ Need JWT |
| Sekolah /ops/schools | TIDAK ADA | MOCK | ❌ Belum |
| Katalog /ops/catalog | `GET /v1/catalog/*` | MOCK | ✅ Partial |
| Prompt /ops/prompts | TIDAK ADA | MOCK | ❌ Belum |
| Jobs /ops/jobs | `GET /v1/admin/jobs` (superadmin token) | MOCK | ⚠️ Need JWT |
| Quality /ops/quality | `GET /v1/admin/quality-reports` (superadmin token) | MOCK | ⚠️ Need JWT |
| Audit /ops/audit | TIDAK ADA | MOCK | ❌ Belum |
| Billing /ops/billing | `GET /v1/school/billing` | MOCK | ⚠️ Partial |
| Flags /ops/flags | TIDAK ADA | MOCK | ❌ Belum |
| Marketing CMS /ops/content | `GET /v1/ops/marketing/pages` (JWT superadmin) | LIVE | ✅ Done |

---

## Task List

### TASK-OPS-01: Account Management (JWT superadmin)
**Status:** TODO
**Estimasi:** 1-2 hari
**Dependencies:** TASK-AUTH-01 (JWT login)

**Kebutuhan:**
- BE: `GET /v1/admin/accounts` → convert dari superadmin token ke JWT `requireRole(['superadmin'])`
- BE: `GET /v1/admin/accounts/:id` → detail user
- BE: `PATCH /v1/admin/accounts/:id/roles` → update role
- BE: `POST /v1/admin/accounts/:id/suspend` → suspend user
- DB: seed 10+ akun berbagai role (teacher, school_admin, superadmin, subscriber)
- FE: connect table ke backend real, filter/search bekerja

**Test:**
- [ ] Register akun baru, muncul di list
- [ ] Update role, reflect di list
- [ ] Suspend akun, status berubah
- [ ] Filter by role, status, nama

---

### TASK-OPS-02: School/Tenant Management
**Status:** TODO
**Estimasi:** 2-3 hari

**Kebutuhan:**
- BE: `GET /v1/admin/schools` → list semua tenant (workspace + billing)
- BE: `GET /v1/admin/schools/:id` → detail sekolah + members
- BE: `POST /v1/admin/schools` → create tenant manual
- BE: `PATCH /v1/admin/schools/:id` → update nama, plan
- BE: `DELETE /v1/admin/schools/:id` → soft delete / archive
- DB: seed 5+ sekolah dengan status beda (pilot, active, grace, blocked)
- DB: seed membership teacher per sekolah
- FE: connect table ke backend

**Test:**
- [ ] List sekolah muncul dengan plan/status/billing
- [ ] Detail sekolah menampilkan members
- [ ] Update plan (pilot→active, active→blocked)

---

### TASK-OPS-03: Prompt Library
**Status:** TODO
**Estimasi:** 1-2 hari

**Kebutuhan:**
- BE: `GET /v1/admin/prompts` → list prompt templates
- BE: `GET /v1/admin/prompts/:id` → detail prompt
- BE: `POST /v1/admin/prompts` → create/update prompt
- BE: `PATCH /v1/admin/prompts/:id/activate` → toggle active/draft
- DB: `admin_prompts` table (id, name, type, prompt_text, version, status, created_by, created_at)
- DB: seed 3 prompt (generate.v3, repair.schema, quality.guard)
- FE: connect table ke backend

**Test:**
- [ ] List prompt muncul dengan status
- [ ] Create prompt baru
- [ ] Activate/deactivate prompt
- [ ] Prompt history/versions

---

### TASK-OPS-04: Audit Trail
**Status:** TODO
**Estimasi:** 1 hari

**Kebutuhan:**
- BE: `GET /v1/admin/audit` → list audit logs
- BE: `GET /v1/admin/audit/:id` → detail entry
- DB: `admin_audit` table (id, actor_id, actor_email, action, target_type, target_id, metadata, created_at)
- DB: auto-log semua superadmin action (role change, plan change, flag toggle, etc.)
- FE: table view dengan timestamp, actor, action, target

**Test:**
- [ ] Update role user → audit log muncul
- [ ] Change plan → audit log muncul
- [ ] Filter by actor, action, date

---

### TASK-OPS-05: Billing Management
**Status:** TODO
**Estimasi:** 1-2 hari

**Kebutuhan:**
- BE: `GET /v1/admin/billing` → list billing status semua tenant
- BE: `GET /v1/admin/billing/:tenantId` → detail billing
- BE: `POST /v1/admin/billing/:tenantId/change-plan` → force plan change
- DB: seed billing data berbeda (active, grace, blocked)
- FE: connect table, show state/renewal/seats

**Test:**
- [ ] List billing dengan status aktif/grace/blocked
- [ ] Change plan dari free ke pro
- [ ] Block tenant, status berubah

---

### TASK-OPS-06: Feature Flags
**Status:** TODO
**Estimasi:** 1 hari

**Kebutuhan:**
- BE: `GET /v1/admin/flags` → list flags
- BE: `PATCH /v1/admin/flags/:key/toggle` → toggle on/off
- BE: `GET /v1/admin/flags/:key/evaluate` → evaluate flag untuk tenant
- DB: `admin_flags` table (id, key, description, enabled, scope, created_at)
- DB: seed 4 flags (share.links, cms.marketing, analytics.creator, ops.bulk_actions)
- FE: toggle button bekerja

**Test:**
- [ ] List flags dengan status on/off
- [ ] Toggle flag, status berubah
- [ ] Flag scoped ke pilot vs global

---

### TASK-OPS-07: Quality Reports Triage
**Status:** TODO
**Estimasi:** 1 hari

**Kebutuhan:**
- BE: `GET /v1/admin/quality-reports` → list (sudah ada, perlu JWT)
- BE: `PATCH /v1/admin/quality-reports/:id/triage` → update status open→triaged→closed
- BE: `POST /v1/admin/quality-reports/:id/resolve` → close report
- DB: seed 5+ quality reports berbeda status
- FE: triage action bekerja

**Test:**
- [ ] List reports dengan status
- [ ] Triage report, status berubah
- [ ] Close report

---

### TASK-OPS-08: Dashboard/KPI Real Data
**Status:** TODO
**Estimasi:** 0.5 hari

**Kebutuhan:**
- BE: `GET /v1/admin/dashboard` → KPI agregat:
  - Total users, active this week
  - Total schools, active/blocked
  - Jobs running/failed today
  - Quality reports open
  - Flags enabled
- Seed data sufficient untuk menampilkan KPI real
- FE: replace hardcoded KPI di ringkasan `/ops`

**Test:**
- [ ] KPI menampilkan angka real dari DB
- [ ] Numbers update saat ada data baru

---

## Execution Order

1. TASK-OPS-08 (Dashboard KPI) — Quick win, buat validasi infrastructure
2. TASK-OPS-01 (Accounts) — Paling fundamental, banyak depend
3. TASK-OPS-02 (Schools) — Core business entity
4. TASK-OPS-04 (Audit) — Logging infrastructure
5. TASK-OPS-05 (Billing) — School dependency
6. TASK-OPS-06 (Flags) — Independent, cepat
7. TASK-OPS-03 (Prompts) — Independent, cepat
8. TASK-OPS-07 (Quality) — Independent, cepat

## Seed Data Strategy

Semua task pakai **seed script** (`scripts/seed-ops-data.mjs`) yang:
- Insert 10+ akun (role berbeda)
- Insert 5+ sekolah (status berbeda)
- Insert 3+ prompt
- Insert 5+ quality reports
- Insert 4+ flags
- Insert 10+ audit entries
- Insert billing data

Seed idempotent: `ON CONFLICT DO NOTHING` / `ON CONFLICT DO UPDATE`.
