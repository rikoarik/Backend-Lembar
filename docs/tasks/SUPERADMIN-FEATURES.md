# Superadmin Ops — Task BE Detail (7 Items)

Updated: 2026-07-25

---

## TASK 1: Schools CRUD (Belum ada BE)

**Status:** ❌ BELUM
**Estimasi:** 2-3 hari

### Yang perlu dibuat

#### 1.1 GET /v1/admin/schools
List semua tenant/sekolah dengan data lengkap.

**Query:**
```sql
SELECT
  t.id, t.name, t.slug,
  COUNT(DISTINCT jw.id) as teachers,
  COALESCE(ab.plan, 'free') as plan,
  COALESCE(ab.state, 'active') as state,
  COALESCE(ab.seats, 0) as seats,
  COALESCE(ab.renews_at, now()) as renews_at,
  (SELECT jw2.email FROM jwt_users jw2 WHERE jw2.workspace_id = t.id AND jw2.roles @> ARRAY['school_admin'] LIMIT 1) as owner_email
FROM tenants t
LEFT JOIN jwt_users jw ON jw.workspace_id = t.id AND jw.roles @> ARRAY['teacher']
LEFT JOIN admin_billing ab ON ab.tenant_id = t.id
GROUP BY t.id, t.name, t.slug, ab.plan, ab.state, ab.seats, ab.renews_at
ORDER BY t.name
```

**Response shape:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "SDN Contoh 01",
      "slug": "sdn-contoh-01",
      "plan": "pilot",
      "state": "active",
      "teachers": 3,
      "seats": 30,
      "renewsAt": "2026-08-24",
      "owner": "admin@sdncontoh.sch.id"
    }
  ]
}
```

#### 1.2 GET /v1/admin/schools/:id
Detail sekolah + members.

**Query:**
```sql
-- School info
SELECT t.id, t.name, t.slug, ab.plan, ab.state, ab.seats, ab.renews_at
FROM tenants t
LEFT JOIN admin_billing ab ON ab.tenant_id = t.id
WHERE t.id = $1

-- Members
SELECT jw.id, jw.email, jw.name, jw.username, jw.roles, jw.created_at
FROM jwt_users jw
WHERE jw.workspace_id = $1
ORDER BY jw.created_at
```

**Response shape:**
```json
{
  "data": {
    "school": { "id": "...", "name": "...", "plan": "...", ... },
    "members": [
      { "id": "...", "email": "...", "name": "...", "roles": ["teacher"], ... }
    ],
    "memberCount": 5
  }
}
```

#### 1.3 POST /v1/admin/schools
Create tenant baru.

**Body:** `{ name: string, slug?: string }`
**Create:** tenants table + admin_billing entry (free plan)

#### 1.4 PATCH /v1/admin/schools/:id
Update nama atau plan.

**Body:** `{ name?: string, plan?: string }`

#### 1.5 DELETE /v1/admin/schools/:id
Soft delete (mark archived) atau hard delete dengan check.

---

## TASK 2: Accounts — tambah name, resolve school, format status

**Status:** ⚠️ Partial
**Estimasi:** 1 hari

### Yang perlu diubah

#### 2.1 Update PostgresAdminDataStore.listAccounts()
```typescript
// Sekarang return:
{ id, email, role, workspaceId, membershipState, createdAt }

// Harus return:
{ id, email, name, displayName, role, status, school, workspaceId, createdAt }
```

**Query perubahan:**
```sql
SELECT
  jw.id, jw.email, jw.name, jw.username,
  jw.roles,
  jw.workspace_id,
  t.name as school_name,
  jw.created_at,
  -- status logic: if workspace archived → ditangguhkan, else aktif
  CASE
    WHEN ab.state = 'blocked' THEN 'ditangguhkan'
    WHEN jw.created_at > now() - interval '7 days' THEN 'baru'
    ELSE 'aktif'
  END as status
FROM jwt_users jw
LEFT JOIN tenants t ON t.id = jw.workspace_id
LEFT JOIN admin_billing ab ON ab.tenant_id = jw.workspace_id
ORDER BY jw.created_at DESC
```

#### 2.2 Update AdminAccountSummary type
```typescript
export interface AdminAccountSummary {
  id: string;
  email: string;
  name: string;
  displayName: string;
  role: 'teacher' | 'school_admin' | 'superadmin' | 'subscriber';
  status: 'aktif' | 'baru' | 'ditangguhkan';
  school: string;
  workspaceId: string;
  createdAt: string;
}
```

#### 2.3 GET /v1/admin/accounts/:id (baru)
Detail akun lengkap + memberships.

---

## TASK 3: Jobs — resolve tenant name, tambah progress

**Status:** ⚠️ Partial
**Estimasi:** 0.5 hari

### Yang perlu diubah

#### 3.1 Update PostgresAdminDataStore.listJobs()
```typescript
// Sekarang return:
{ id, workspaceId, actorId, kind, status, attempt, createdAt }

// Harus return:
{ id, type, tenant, status, progress, updatedAt, attempt }
```

**Query perubahan:**
```sql
SELECT
  sj.id,
  sj.kind as type,
  COALESCE(t.name, sj.workspace_id) as tenant,
  sj.status,
  CASE
    WHEN sj.status = 'succeeded' THEN '100%'
    WHEN sj.status = 'running' THEN 'running'
    WHEN sj.status = 'failed' THEN 'failed'
    WHEN sj.status = 'queued' THEN 'queued'
    ELSE 'pending'
  END as progress,
  sj.updated_at,
  sj.attempt
FROM spike_jobs sj
LEFT JOIN tenants t ON t.id = sj.workspace_id
ORDER BY sj.updated_at DESC
LIMIT $1
```

---

## TASK 4: Quality Reports — tambah reason + reporter

**Status:** ⚠️ Partial
**Estimasi:** 0.5 hari

### Yang perlu diubah

#### 4.1 Update PostgresAdminDataStore.listQualityReports()
```typescript
// Sekarang return:
{ id, workspaceId, assessmentVersionId, valid, issueCount, createdAt }

// Harus return:
{ id, reason, status, reporter, createdAt }
```

**Query sudah ada di routes** — cukup update response mapping.

#### 4.2 Update AdminQualityReport type
```typescript
export interface AdminQualityReport {
  id: string;
  reason: string;
  status: 'open' | 'triaged' | 'closed';
  reporter: string;
  notes: string;
  createdAt: string;
}
```

---

## TASK 5: Audit — format actor + target

**Status:** ⚠️ Partial
**Estimasi:** 0.5 hari

### Yang perlu diubah

#### 5.1 GET /v1/admin/audit — update response mapping
```typescript
// Sekarang return:
{ id, actor_id, actor_email, action, target_type, target_id, metadata, created_at }

// Harus return:
{ id, at, actor, action, target }
```

**Mapping:**
- `at` = format `created_at` → "2026-07-24 10:12"
- `actor` = `actor_email`
- `target` = `target_id` (bisa resolve ke nama tergantung target_type)

#### 5.2 Tambah filter params
```
GET /v1/admin/audit?action=flag.toggle&actor=ops@lembar.id&from=2026-07-01&to=2026-07-31&limit=50
```

---

## TASK 6: Prompts — rename field

**Status:** ⚠️ Partial
**Estimasi:** 0.2 hari

### Yang perlu diubah

#### 6.1 GET /v1/admin/prompts — update response mapping
```typescript
// Sekarang return:
{ id, name, slug, description, version, status, created_by, created_at, updated_at }

// Harus return:
{ id, name, owner, status }
```

**Mapping:**
- `owner` = `created_by`

---

## TASK 7: Billing — minor field mapping

**Status:** ⚠️ Partial
**Estimasi:** 0.2 hari

### Yang perlu diubah

#### 7.1 GET /v1/admin/billing — update response mapping
```typescript
// Sekarang return:
{ id, tenant_id, school_name, state, seats, plan, renews_at, ... }

// Harus return:
{ id, school, state, seats, renotesAt }
```

**Mapping:**
- `school` = `school_name`
- `renewsAt` = format `renews_at` → "2026-08-24"

---

## Execution Order

| # | Task | Estimasi | Status |
|---|---|---|---|
| 1 | TASK 1: Schools CRUD | 2-3 hari | ❌ BELUM |
| 2 | TASK 2: Accounts field fix | 1 hari | ⚠️ |
| 3 | TASK 3: Jobs field fix | 0.5 hari | ⚠️ |
| 4 | TASK 4: Quality field fix | 0.5 hari | ⚠️ |
| 5 | TASK 5: Audit field fix | 0.5 hari | ⚠️ |
| 6 | TASK 6: Prompts field fix | 0.2 hari | ⚠️ |
| 7 | TASK 7: Billing field fix | 0.2 hari | ⚠️ |

**Total: 5-6 hari**
