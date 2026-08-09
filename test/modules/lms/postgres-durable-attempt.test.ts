import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { DurableAttemptService } from '../../../src/modules/lms/application/DurableAttemptService.js';
import { PostgresAttemptStore } from '../../../src/modules/lms/persistence/PostgresAttemptStore.js';

const describeDb = process.env['DATABASE_URL'] ? describe : describe.skip;
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const assessmentId = randomUUID();
const shareId = randomUUID();
const otherShareId = randomUUID();
const questionId = randomUUID();
let pool: Pool;

describeDb('Postgres durable attempt integration', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL']! });
    const migration = await readFile(
      'src/infrastructure/database/migrations/0028_assessment_attempts.sql',
      'utf8',
    );
    await pool.query(migration);
    await pool.query(
      `INSERT INTO assessments(id,workspace_id,creator_user_id,title,status,current_version) VALUES($1,$2,$3,'LMS PG','ready',1)`,
      [assessmentId, workspaceId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO assessment_versions(id,assessment_id,workspace_id,version,status,config_snapshot) VALUES($1,$2,$3,1,'ready','{}')`,
      [randomUUID(), assessmentId, workspaceId],
    );
    await pool.query(
      `INSERT INTO generated_questions(id,workspace_id,assessment_version_id,blueprint_sequence,question_type,difficulty,stem,options,answer,explanation,source_ids,version_metadata) VALUES($1,$2,$3,0,'multiple_choice','easy','2+2?','[]','A','secret','[]','{}')`,
      [questionId, workspaceId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO share_links(id,workspace_id,assessment_id,token,expires_at) VALUES($1,$2,$3,'pg-token',now()+interval '1 day'),($4,$5,$3,'other-token',now()+interval '1 day')`,
      [shareId, workspaceId, assessmentId, otherShareId, otherWorkspaceId],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM assessment_attempts WHERE assessment_id=$1`, [assessmentId]);
    await pool.query(`DELETE FROM share_links WHERE id IN ($1,$2)`, [shareId, otherShareId]);
    await pool.query(`DELETE FROM generated_questions WHERE id=$1`, [questionId]);
    await pool.query(`DELETE FROM assessment_versions WHERE assessment_id=$1`, [assessmentId]);
    await pool.query(`DELETE FROM assessments WHERE id=$1`, [assessmentId]);
    await pool.end();
  });

  it('persists create, recreation, UUID autosave, submit, idempotency and tenant results', async () => {
    const first = new DurableAttemptService(new PostgresAttemptStore(pool));
    const started = await first.start({ id: shareId, workspaceId, assessmentId }, 'Siswa', '7A');
    const recreated = new DurableAttemptService(new PostgresAttemptStore(pool));
    expect(
      (await recreated.autosave(started.id, { [questionId]: 'A' }, shareId, [questionId])).answers,
    ).toEqual({ [questionId]: 'A' });
    await expect(
      recreated.autosave(started.id, { [randomUUID()]: 'forged' }, shareId, [questionId]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      recreated.autosave(started.id, { 'not-a-uuid': 'forged' }, shareId, [questionId]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      recreated.autosave(started.id, { [questionId]: 'B' }, otherShareId, [questionId]),
    ).rejects.toMatchObject({ status: 404 });
    const questions = [
      { id: questionId, questionType: 'multiple_choice', stem: '2+2?', options: [], answer: 'A' },
    ];
    const submitted = await recreated.submit(started.id, questions, shareId);
    const again = await recreated.submit(started.id, questions, shareId);
    expect(again.submittedAt).toBe(submitted.submittedAt);
    expect(again.rawScore).toBe(1);
    expect(await recreated.results(otherWorkspaceId, assessmentId)).toEqual([]);
    expect((await recreated.results(workspaceId, assessmentId))[0]).toMatchObject({
      id: started.id,
      status: 'submitted',
      rawScore: 1,
    });
  });
});
