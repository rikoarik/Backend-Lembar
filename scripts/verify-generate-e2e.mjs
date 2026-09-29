// End-to-end proof for t_56fca46d:
//  1. create a fresh assessment via the live API
//  2. submit an assessment_generation job to /v1/jobs
//  3. poll spike_jobs + ai_jobs_audit + generated_questions for the outcome
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const env = {};
for (const line of readFileSync('.env', 'utf-8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i === -1) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const workspaceId = '105f43bf-a27c-43fb-b344-7e94a892fceb'; // sdn-contoh-01
const userId = '67021a63-d54c-4ee3-a1a5-6ea7db226209'; // siti.nurhaliza@sdncontoh.sch.id
const token = jwt.sign(
  { userId, email: 'siti.nurhaliza@sdncontoh.sch.id', roles: ['teacher'], workspaceId },
  env.JWT_SECRET,
  { algorithm: 'HS256', expiresIn: '1d' },
);
const H = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
const api = 'http://127.0.0.1:4000';

const blueprintItems = [0, 1, 2].map((sequence) => ({
  sequence,
  outcomeId: null,
  topicHint: 'penjumlahan pecahan sederhana',
  difficulty: 'medium',
  questionType: 'multiple_choice',
  cognitiveLevel: null,
  sourceUploadId: null,
}));

// 1. create assessment
const createRes = await fetch(`${api}/v1/workspaces/${workspaceId}/assessments`, {
  method: 'POST',
  headers: { ...H, 'idempotency-key': `e2e-t56fca46d-create-${Date.now()}` },
  body: JSON.stringify({
    title: `E2E t_56fca46d ${new Date().toISOString()}`,
    curriculumVersionId: '11111111-1111-1111-1111-111111111111',
    gradeId: 'official-grade-paud-paud',
    subjectId: 'subject-matematika',
    gradeLabel: 'PAUD — Fase Fondasi',
    subjectLabel: 'Matematika',
    assessmentType: 'practice',
    academicYear: '2026/2027',
    durationMinutes: 30,
    blueprintItems,
    imageGeneration: { mode: 'none', style: 'auto', maxImages: 1 },
    generationContext: { sourceMode: 'catalog', materialIds: [], teacherFocus: 'penjumlahan pecahan sederhana', exampleQuestion: '' },
  }),
});
const created = await createRes.json();
console.log('CREATE HTTP', createRes.status, 'assessment=', created.assessment?.id, 'version=', created.version?.id);
if (createRes.status >= 300) { console.log(JSON.stringify(created, null, 2)); process.exit(1); }

// 2. submit generation job
const idem = `e2e-t56fca46d-gen-${Date.now()}`;
const submitRes = await fetch(`${api}/v1/jobs`, {
  method: 'POST',
  headers: { ...H, 'x-request-id': 'verify-t_56fca46d' },
  body: JSON.stringify({
    operation: 'assessment_generation',
    idempotencyKey: idem,
    workspaceId,
    payload: {
      assessmentId: created.assessment.id,
      assessmentVersionId: created.version.id,
      blueprintSchemaVersion: '1.0',
      reviewMode: 'quick',
      progressTotal: 3,
      progressCurrent: 0,
      blueprintItems,
      imageGeneration: { mode: 'none', style: 'auto', maxImages: 1 },
      generationContext: { sourceMode: 'catalog', materialIds: [], teacherFocus: 'penjumlahan pecahan sederhana', exampleQuestion: '' },
    },
  }),
});
const submitted = await submitRes.json();
console.log('SUBMIT HTTP', submitRes.status, 'jobId=', submitted.jobId);
if (submitRes.status >= 300) { console.log(JSON.stringify(submitted, null, 2)); process.exit(1); }

// 3. poll
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const jobId = submitted.jobId;
const versionId = created.version.id;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const job = await pool.query('select status, attempt, last_error from spike_jobs where id=$1', [jobId]);
  const gq = await pool.query('select count(*)::int as n from generated_questions where assessment_version_id=$1', [versionId]);
  const asmt = await pool.query('select status from assessments where id=$1', [created.assessment.id]);
  const st = job.rows[0];
  console.log(`t+${(i + 1) * 5}s job=${st?.status} attempt=${st?.attempt} generated=${gq.rows[0].n} assessment=${asmt.rows[0]?.status}`);
  if (['succeeded', 'failed', 'dead_letter', 'partially_succeeded'].includes(st?.status)) break;
}

const audit = await pool.query(
  'select outcome, driver, provider_model_id, latency_ms, response_byte_length, redacted_error from ai_jobs_audit order by created_at desc limit 3',
);
console.log('\nAI AUDIT (latest 3):');
console.table(audit.rows);
const finalQ = await pool.query(
  'select blueprint_sequence, question_type, left(stem, 70) as stem from generated_questions where assessment_version_id=$1 order by blueprint_sequence',
  [versionId],
);
console.log('\nGENERATED QUESTIONS:');
console.table(finalQ.rows);
console.log('\nASSESSMENT_ID', created.assessment.id, 'VERSION_ID', versionId, 'JOB_ID', jobId);
await pool.end();
