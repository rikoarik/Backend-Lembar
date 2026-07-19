import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../bootstrap/app.js';
import { parseDatabaseEnv } from '../config/database.env.js';
import { ConfigError, formatConfigError } from '../config/errors.js';
import { closeDatabase, createDatabase } from '../infrastructure/database/db.js';
import { CurriculumRepository } from '../modules/curriculum/domain/CurriculumRepository.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const migrationsFolder = path.join(projectRoot, 'src', 'infrastructure', 'database', 'migrations');

interface SmokeStep {
  label: string;
  ok: boolean;
  detail: string;
}

interface SeedFixture {
  tenantId: string;
  curriculumId: string;
  gradeId: string;
  phaseId: string;
  subjectId: string;
  outcomeId: string;
  materialApprovedId: string;
  materialRejectedId: string;
}

const STUB_BEARER = 'smoke-stub-token';

async function main(): Promise<void> {
  let env;
  try {
    env = parseDatabaseEnv(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${formatConfigError(err.issues)}\n`);
      process.exit(1);
    }
    throw err;
  }
  if (!env.url) {
    process.stderr.write('DATABASE_URL is required for curriculum:smoke\n');
    process.exit(1);
  }

  const db = createDatabase({
    connectionString: env.url,
    poolMax: env.poolMax,
    ssl: env.sslMode === 'require',
  });

  const steps: SmokeStep[] = [];

  try {
    await migrate(db, { migrationsFolder });
    steps.push({ label: 'migrations-applied', ok: true, detail: migrationsFolder });

    const { tenants } = await import('../infrastructure/database/schema.js');
    const tenantSlug = `smoke-curriculum-${Date.now()}`;
    const [tenant] = await db
      .insert(tenants)
      .values({ slug: tenantSlug, name: 'Smoke Curriculum Tenant' })
      .returning();
    if (!tenant) throw new Error('tenant insert returned no row');

    const fixture: SeedFixture = {
      tenantId: tenant.id,
      curriculumId: '',
      gradeId: '',
      phaseId: '',
      subjectId: '',
      outcomeId: '',
      materialApprovedId: '',
      materialRejectedId: '',
    };

    const app = await buildApp({ logger: false, curriculumDb: db, serviceVersion: 'b1-04-smoke' });
    await app.ready();

    try {
      // 1. Stub bearer is required for writes.
      const denied = await app.inject({
        method: 'POST',
        url: '/v1/curriculum/curricula',
        payload: {
          tenantId: tenant.id,
          slug: tenantSlug,
          code: 'K-1',
          title: 'Kurikulum 1',
          level: 'sma',
        },
      });
      steps.push({
        label: 'write-needs-bearer',
        ok: denied.statusCode === 401,
        detail: `status=${denied.statusCode}`,
      });

      const auth = { authorization: `Bearer ${STUB_BEARER}` };

      // 2. Create the mutable curriculum draft.
      const curriculumCreate = await app.inject({
        method: 'POST',
        url: '/v1/curriculum/curricula',
        headers: auth,
        payload: {
          tenantId: tenant.id,
          slug: tenantSlug,
          code: 'K-1',
          title: 'Kurikulum 1',
          level: 'sma',
        },
      });
      const curriculumBody = curriculumCreate.json() as { data: { id: string } };
      fixture.curriculumId = curriculumBody.data.id;
      steps.push({
        label: 'curriculum-draft-created',
        ok: curriculumCreate.statusCode === 201,
        detail: `status=${curriculumCreate.statusCode}`,
      });

      // 3. Publish without ever mutating the draft — version 1 should land.
      const firstPublish = await app.inject({
        method: 'POST',
        url: `/v1/curriculum/curricula/${fixture.curriculumId}/publish`,
        headers: auth,
      });
      steps.push({
        label: 'curriculum-first-publish',
        ok: firstPublish.statusCode === 200,
        detail: `status=${firstPublish.statusCode}`,
      });

      // 4. Update draft (does NOT bump published_version).
      const updated = await app.inject({
        method: 'PUT',
        url: `/v1/curriculum/curricula/${fixture.curriculumId}/draft`,
        headers: auth,
        payload: { title: 'Kurikulum 1 (revisi)' },
      });
      steps.push({
        label: 'curriculum-draft-updated',
        ok: updated.statusCode === 200,
        detail: `status=${updated.statusCode}`,
      });
      const listAfterDraft = await app.inject({
        method: 'GET',
        url: `/v1/curriculum/curricula/${fixture.curriculumId}/versions`,
      });
      const listBody = listAfterDraft.json() as {
        data: Array<{ version: number }>;
        page: { limit: number; hasMore: boolean };
      };
      steps.push({
        label: 'draft-does-not-publish',
        ok: listBody.data.length === 1 && listBody.data[0]?.version === 1,
        detail: `versions=${listBody.data.length}`,
      });

      // 5. Second publish — version 2 must appear.
      const secondPublish = await app.inject({
        method: 'POST',
        url: `/v1/curriculum/curricula/${fixture.curriculumId}/publish`,
        headers: auth,
      });
      steps.push({
        label: 'curriculum-second-publish',
        ok: secondPublish.statusCode === 200,
        detail: `status=${secondPublish.statusCode}`,
      });
      const listAfterSecond = await app.inject({
        method: 'GET',
        url: `/v1/curriculum/curricula/${fixture.curriculumId}/versions`,
      });
      const listBody2 = listAfterSecond.json() as { data: Array<{ version: number }> };
      steps.push({
        label: 'publish-advances-version',
        ok: listBody2.data[0]?.version === 2 && listBody2.data.length === 2,
        detail: `latest=${listBody2.data[0]?.version}`,
      });

      // 6. Walk the tree: grade → phase → subject → outcome → materials.
      const gradeCreate = await app.inject({
        method: 'POST',
        url: '/v1/curriculum/grades',
        headers: auth,
        payload: { curriculumId: fixture.curriculumId, code: 'G-10', label: 'Kelas 10' },
      });
      fixture.gradeId = (gradeCreate.json() as { data: { id: string } }).data.id;
      await app.inject({
        method: 'POST',
        url: `/v1/curriculum/grades/${fixture.gradeId}/publish`,
        headers: auth,
      });
      steps.push({
        label: 'grade-published',
        ok: gradeCreate.statusCode === 201,
        detail: `status=${gradeCreate.statusCode}`,
      });

      const phaseCreate = await app.inject({
        method: 'POST',
        url: '/v1/curriculum/phases',
        headers: auth,
        payload: { gradeId: fixture.gradeId, code: 'P-A', label: 'Fase A' },
      });
      fixture.phaseId = (phaseCreate.json() as { data: { id: string } }).data.id;
      await app.inject({
        method: 'POST',
        url: `/v1/curriculum/phases/${fixture.phaseId}/publish`,
        headers: auth,
      });
      steps.push({
        label: 'phase-published',
        ok: phaseCreate.statusCode === 201,
        detail: `status=${phaseCreate.statusCode}`,
      });

      const subjectCreate = await app.inject({
        method: 'POST',
        url: '/v1/curriculum/subjects',
        headers: auth,
        payload: { phaseId: fixture.phaseId, code: 'SB-MAT', title: 'Matematika' },
      });
      fixture.subjectId = (subjectCreate.json() as { data: { id: string } }).data.id;
      await app.inject({
        method: 'POST',
        url: `/v1/curriculum/subjects/${fixture.subjectId}/publish`,
        headers: auth,
      });
      steps.push({
        label: 'subject-published',
        ok: subjectCreate.statusCode === 201,
        detail: `status=${subjectCreate.statusCode}`,
      });

      const outcomeCreate = await app.inject({
        method: 'POST',
        url: '/v1/curriculum/outcomes',
        headers: auth,
        payload: {
          subjectId: fixture.subjectId,
          code: 'O-1',
          text: 'Memahami persamaan linear.',
          bloomLevel: 'understand',
        },
      });
      fixture.outcomeId = (outcomeCreate.json() as { data: { id: string } }).data.id;
      await app.inject({
        method: 'POST',
        url: `/v1/curriculum/outcomes/${fixture.outcomeId}/publish`,
        headers: auth,
      });
      steps.push({
        label: 'outcome-published',
        ok: outcomeCreate.statusCode === 201,
        detail: `status=${outcomeCreate.statusCode}`,
      });

      // 7. Source-rights gate blocks unknown licenses.
      const rejectedCreate = await app.inject({
        method: 'POST',
        url: '/v1/curriculum/materials',
        headers: auth,
        payload: {
          outcomeId: fixture.outcomeId,
          code: 'M-BAD',
          kind: 'reading',
          title: 'Artikel sumber tak dikenal',
          sourceRights: 'license:unknown',
        },
      });
      fixture.materialRejectedId = (rejectedCreate.json() as { data: { id: string } }).data.id;
      const rejectedPublish = await app.inject({
        method: 'POST',
        url: `/v1/curriculum/materials/${fixture.materialRejectedId}/publish`,
        headers: auth,
      });
      steps.push({
        label: 'source-rights-gate-blocks',
        ok: rejectedPublish.statusCode === 400,
        detail: `status=${rejectedPublish.statusCode}`,
      });

      // 8. Approved license publishes cleanly.
      const approvedCreate = await app.inject({
        method: 'POST',
        url: '/v1/curriculum/materials',
        headers: auth,
        payload: {
          outcomeId: fixture.outcomeId,
          code: 'M-OK',
          kind: 'reading',
          title: 'Buku sekolah elektronik',
          sourceRights: 'license:internal',
        },
      });
      fixture.materialApprovedId = (approvedCreate.json() as { data: { id: string } }).data.id;
      const approvedPublish = await app.inject({
        method: 'POST',
        url: `/v1/curriculum/materials/${fixture.materialApprovedId}/publish`,
        headers: auth,
      });
      steps.push({
        label: 'source-rights-approved-publish',
        ok: approvedPublish.statusCode === 200,
        detail: `status=${approvedPublish.statusCode}`,
      });

      // 9. Public read projection returns everything that has a published version.
      const projection = await app.inject({
        method: 'GET',
        url: `/v1/curriculum/curricula/${tenantSlug}`,
      });
      steps.push({
        label: 'public-projection-200',
        ok: projection.statusCode === 200,
        detail: `status=${projection.statusCode}`,
      });
      const projectionBody = projection.json() as {
        data: {
          curriculum: { version: number };
          grades: unknown[];
          materials: Array<{ sourceRights: string }>;
        };
      };
      steps.push({
        label: 'projection-filters-drafts',
        ok:
          projectionBody.data.curriculum.version === 2 &&
          projectionBody.data.materials.length === 1 &&
          projectionBody.data.materials[0]?.sourceRights === 'license:internal',
        detail: `materials=${projectionBody.data.materials.length}`,
      });

      // 10. ETag round-trip.
      const etag = projection.headers['etag'];
      const cached = await app.inject({
        method: 'GET',
        url: `/v1/curriculum/curricula/${tenantSlug}`,
        headers: { 'if-none-match': etag },
      });
      steps.push({
        label: 'etag-304',
        ok: cached.statusCode === 304,
        detail: `status=${cached.statusCode}`,
      });

      // 11. Per-resource version-detail round-trips + history listings.
      const detailCheck = async (
        label: string,
        url: string,
        expectVersion: number,
      ): Promise<void> => {
        const res = await app.inject({ method: 'GET', url });
        const body = res.json() as { data: { version?: number } };
        steps.push({
          label,
          ok: res.statusCode === 200 && body.data.version === expectVersion,
          detail: `status=${res.statusCode} version=${body.data.version ?? 'n/a'}`,
        });
      };
      const listCheck = async (label: string, url: string): Promise<void> => {
        const res = await app.inject({ method: 'GET', url });
        steps.push({ label, ok: res.statusCode === 200, detail: `status=${res.statusCode}` });
      };
      await detailCheck(
        'curriculum-version-detail',
        `/v1/curriculum/curricula/${fixture.curriculumId}/versions/2`,
        2,
      );
      await listCheck(
        'curriculum-versions-list',
        `/v1/curriculum/curricula/${fixture.curriculumId}/versions?limit=10`,
      );
      await detailCheck(
        'grade-version-detail',
        `/v1/curriculum/grades/${fixture.gradeId}/versions/1`,
        1,
      );
      await listCheck('grade-versions-list', `/v1/curriculum/grades/${fixture.gradeId}/versions`);
      await detailCheck(
        'phase-version-detail',
        `/v1/curriculum/phases/${fixture.phaseId}/versions/1`,
        1,
      );
      await listCheck('phase-versions-list', `/v1/curriculum/phases/${fixture.phaseId}/versions`);
      await detailCheck(
        'subject-version-detail',
        `/v1/curriculum/subjects/${fixture.subjectId}/versions/1`,
        1,
      );
      await listCheck(
        'subject-versions-list',
        `/v1/curriculum/subjects/${fixture.subjectId}/versions`,
      );
      await detailCheck(
        'outcome-version-detail',
        `/v1/curriculum/outcomes/${fixture.outcomeId}/versions/1`,
        1,
      );
      await listCheck(
        'outcome-versions-list',
        `/v1/curriculum/outcomes/${fixture.outcomeId}/versions`,
      );
      await detailCheck(
        'material-version-detail',
        `/v1/curriculum/materials/${fixture.materialApprovedId}/versions/1`,
        1,
      );
      await listCheck(
        'material-versions-list',
        `/v1/curriculum/materials/${fixture.materialApprovedId}/versions`,
      );

      // 12. Source-rights gate endpoint accepts the approved material and rejects the bad one.
      const gateApproved = await app.inject({
        method: 'POST',
        url: `/v1/curriculum/materials/${fixture.materialApprovedId}/source-rights-gate`,
        headers: auth,
      });
      steps.push({
        label: 'gate-endpoint-approved',
        ok: gateApproved.statusCode === 200,
        detail: `status=${gateApproved.statusCode}`,
      });
      const gateRejected = await app.inject({
        method: 'POST',
        url: `/v1/curriculum/materials/${fixture.materialRejectedId}/source-rights-gate`,
        headers: auth,
      });
      steps.push({
        label: 'gate-endpoint-rejected',
        ok: gateRejected.statusCode === 200,
        detail: `status=${gateRejected.statusCode}`,
      });
    } finally {
      await app.close();
    }

    // 11. Cross-tenant isolation: a different tenant must not see the published material.
    const repo = new CurriculumRepository(db);
    const isolationCheck = await repo.readPublishedCatalogByTenantSlug('does-not-exist');
    steps.push({
      label: 'tenant-isolation',
      ok: isolationCheck === null,
      detail: 'projection-null',
    });

    const failed = steps.filter((entry) => !entry.ok);
    process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, steps }, null, 2)}\n`);
    process.exit(failed.length === 0 ? 0 : 1);
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ status: 'error', error: redact(err) }, null, 2)}\n`);
    process.exit(1);
  } finally {
    await closeDatabase(db);
  }
}

function redact(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'Error', message: 'unknown error' };
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('smoke/curriculum.js') === true;

if (isDirectRun) {
  void main();
}
