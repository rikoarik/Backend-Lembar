# Superadmin Ops — Task BE per Fitur

Status: updated
Updated: 2026-07-25

---

## Ringkasan Status per Menu

| Menu | FE Data | BE Endpoint | Status |
|---|---|---|---|
| `/ops` Ringkasan | KPI hardcoded | `GET /v1/admin/dashboard` ✅ | ✅ Done |
| `/ops/accounts` | MOCK 5 rows | `GET /v1/admin/accounts` ✅ | ✅ Done |
| `/ops/schools` | MOCK 4 rows | TIDAK ADA | ❌ Need BE |
| `/ops/catalog` | MOCK 3 rows | `GET /v1/catalog/*` ✅ | ✅ Done |
| `/ops/prompts` | MOCK 3 rows | `GET /v1/admin/prompts` ✅ | ✅ Done |
| `/ops/jobs` | MOCK 4 rows | `GET /v1/admin/jobs` ✅ | ✅ Done |
| `/ops/quality` | MOCK 3 rows | `GET /v1/admin/quality-reports` ✅ | ✅ Done |
| `/ops/audit` | MOCK 3 rows | `GET /v1/admin/audit` ✅ | ✅ Done |
| `/ops/billing` | MOCK 4 rows | `GET /v1/admin/billing` ✅ | ✅ Done |
| `/ops/flags` | MOCK 4 rows | `GET /v1/admin/flags` ✅ | ✅ Done |
| `/ops/content` | MOCK 3 rows | `GET /v1/ops/marketing/pages` ✅ | ✅ Done |

---

## TASK 1: /ops/schools — School/Tenant Management

**Status:** ❌ BELUM — ini satu-satunya menu yang belum ada BE-nya
**Estimasi:** 2-3 hari
**Prioritas:** Tinggi (core entity)

### FE yang perlu dilayani

```typescript
type SchoolRow = {
  id: string;
  name: string;
  plan: 'pilot' | 'active' | 'grace' | 'blocked';
  teachers: number;
  usage: string;  // "312/500"
  owner: string;
};
```

### BE endpoints yang perlu dibuat

1. **`GET /v1/admin/schools`** — List semua tenant/sekolah
   - Response: `SchoolRow[]` dengan plan, teacher count, usage, owner
   - Query tenant dari `tenants` table
   - JOIN `jwt_users` untuk dapat teacher count per tenant
   - JOIN `admin_billing` untuk plan/state
   - Filter: search, plan, state
   - Sort: name, teachers, plan

2. **`GET /v1/admin/schools/:id`** — Detail sekolah
   - Response: School detail + members list + billing info
   - Query: tenant info, jwt_users where workspace_id matches, admin_billing

3. **`POST /v1/admin/schools`** — Create tenant manual
   - Body: `{ name: string, slug?: string, ownerEmail?: string }`
   - Create tenant in `tenants` table
   - Optionally create admin membership

4. **`PATCH /v1/admin/schools/:id`** — Update sekolah
   - Body: `{ name?: string, plan?: string }`
   - Update tenant name
   - Update billing plan

5. **`DELETE /v1/admin/schools/:id`** — Soft delete/archive
   - Set tenant status to archived (new column)
   - Atau hard delete dengan cascading

### DB seed
- 5-6 sekolah dari tenants yang sudah ada
- Billing data sudah ada dari seed sebelumnya
- Teacher count dari jwt_users

### Test
- [ ] List sekolah menampilkan plan, teacher count, usage
- [ ] Detail sekolah menampilkan members
- [ ] Create sekolah baru
- [ ] Update plan sekolah

---

## TASK 2: /ops/schools Detail & Bulk Actions

**Status:** ❌ BELUM (extension dari TASK 1)
**Estimasi:** 1-2 hari
**Prioritas:** Medium

### FE yang perlu dilayani
- Row actions: "Buka" → detail page
- Row actions: "Ubah plan" → modal/form
- Bulk actions: suspend/activate multiple schools

### BE endpoints

1. **`GET /v1/admin/schools/:id/members`** — List members sekolah
   - Query jwt_users WHERE workspace_id = tenant.id

2. **`PATCH /v1/admin/schools/:id/members/:userId/suspend`** — Suspend member
   - Update membership state

3. **`POST /v1/admin/schools/:id/invite`** — Invite member
   - Create school_invitation

### Test
- [ ] List members dengan role dan status
- [ ] Suspend member

---

## TASK 3: /ops/accounts — Account Enhancement

**Status:** ⚠️ Partial — list sudah jalan, perlu detail + actions
**Estimasi:** 1 hari
**Prioritas:** Medium

### FE yang perlu dilayani
- Row actions: "Detail" → detail modal
- Row actions: "Impersonate" → login as other user
- Bulk actions: suspend, reset password

### BE endpoints

1. **`GET /v1/admin/accounts/:id`** — Detail akun
   - Full user info + membership + last login

2. **`PATCH /v1/admin/accounts/:id/roles`** — Update role
   - Body: `{ roles: string[] }`
   - Audit logged

3. **`POST /v1/admin/accounts/:id/suspend`** — Suspend user
   - Update membership state

4. **`POST /v1/admin/accounts/:id/reset-password`** — Send password reset
   - Create recovery token

5. **`POST /v1/admin/accounts/:id/impersonate`** — Login as user (ops only)
   - Generate JWT for target user

### Test
- [ ] Detail akun menampilkan info lengkap
- [ ] Update role
- [ ] Suspend akun
- [ ] Reset password trigger

---

## TASK 4: /ops/quality — Quality Report Enhancement

**Status:** ⚠️ Partial — list + triage sudah jalan
**Estimasi:** 0.5 hari
**Prioritas:** Low

### FE yang perlu dilayani
- Row actions: "Triage" → update status
- Row actions: "Tutup" → close report

### BE endpoints
- Sudah ada: `GET /v1/admin/quality-reports`, `PATCH /v1/admin/quality-reports/:id`
- Perlu tambah: `POST /v1/admin/quality-reports/:id/resolve`

### Test
- [ ] Triage report, status open → triaged
- [ ] Resolve report, status → closed
- [ ] Audit log tercatat

---

## TASK 5: /ops/jobs — Job Monitor Enhancement

**Status:** ⚠️ Partial — list sudah jalan
**Estimasi:** 0.5 hari
**Prioritas:** Low

### FE yang perlu dilayani
- Row actions: "Detail" → detail modal
- Row actions: "Retry" → retry failed job

### BE endpoints
- Sudah ada: `GET /v1/admin/jobs`
- Perlu tambah: `POST /v1/admin/jobs/:id/retry`

### Test
- [ ] List jobs dengan status dan progress
- [ ] Retry failed job

---

## TASK 6: /ops/audit — Audit Trail Enhancement

**Status:** ⚠️ Partial — list sudah jalan
**Estimasi:** 0.5 hari
**Prioritas:** Low

### FE yang perlu dilayani
- Row actions: "Detail" → detail modal
- Filter by action, actor, date

### BE endpoints
- Sudah ada: `GET /v1/admin/audit`
- Perlu tambah: `GET /v1/admin/audit/:id` (detail)
- Perlu tambah: filter params `?action=...&actor=...&from=...&to=...`

### Test
- [ ] Filter by action type
- [ ] Filter by actor
- [ ] Filter by date range

---

## TASK 7: /ops/content — Marketing CMS Enhancement

**Status:** ⚠️ Partial — list + publish/unpublish sudah jalan
**Estimasi:** 0.5 hari
**Prioritas:** Low

### FE yang perlu dilayani
- Row actions: "Edit" → edit page
- Row actions: "Publish"/"Unpublish" → toggle

### BE endpoints
- Sudah ada: `GET /v1/ops/marketing/pages`, `PUT .../draft`, `POST .../publish`, `POST .../unpublish`
- Perlu tambah: nothing — sudah lengkap

---

## TASK 8: /ops/prompts — Prompt Management Enhancement

**Status:** ⚠️ Partial — list + create + status toggle sudah jalan
**Estimasi:** 0.5 hari
**Prioritas:** Low

### FE yang perlu dilayani
- Row actions: "Buka" → detail/edit modal

### BE endpoints
- Sudah ada: `GET /v1/admin/prompts`, `POST /v1/admin/prompts`, `PATCH /v1/admin/prompts/:slug/status`
- Perlu tambah: `GET /v1/admin/prompts/:slug` (detail), `PATCH /v1/admin/prompts/:slug` (update text)

---

## TASK 9: /ops/billing — Billing Enhancement

**Status:** ⚠️ Partial — list sudah jalan
**Estimasi:** 0.5 hari
**Prioritas:** Low

### FE yang perlu dilayani
- Row actions: "Kelola" → billing detail modal

### BE endpoints
- Sudah ada: `GET /v1/admin/billing`, `PATCH /v1/admin/billing/:id`
- Perlu tambah: `GET /v1/admin/billing/:id` (detail)

---

## TASK 10: /ops/flags — Feature Flag Enhancement

**Status:** ⚠️ Partial — list + toggle sudah jalan
**Estimasi:** 0.5 hari
**Prioritas:** Low

### FE yang perlu dilayani
- Toggle button langsung
- Scope filter

### BE endpoints
- Sudah ada: `GET /v1/admin/flags`, `PATCH /v1/admin/flags/:key/toggle`
- Perlu tambah: `POST /v1/admin/flags` (create), `PATCH /v1/admin/flags/:key` (update description/scope)

---

## Execution Order (Revised)

| # | Task | Estimasi | Status |
|---|---|---|---|
| 1 | TASK 1: Schools CRUD | 2-3 hari | ❌ BELUM |
| 2 | TASK 3: Accounts detail + actions | 1 hari | ⚠️ Partial |
| 3 | TASK 2: Schools detail + bulk | 1-2 hari | ❌ BELUM |
| 4 | TASK 4: Quality triage | 0.5 hari | ⚠️ Partial |
| 5 | TASK 5: Jobs retry | 0.5 hari | ⚠️ Partial |
| 6 | TASK 6: Audit filter | 0.5 hari | ⚠️ Partial |
| 7 | TASK 7: Content (done) | 0 | ✅ Done |
| 8 | TASK 8: Prompts detail | 0.5 hari | ⚠️ Partial |
| 9 | TASK 9: Billing detail | 0.5 hari | ⚠️ Partial |
| 10 | TASK 10: Flags create | 0.5 hari | ⚠️ Partial |

**Total estimasi: 6-8 hari untuk full coverage**
