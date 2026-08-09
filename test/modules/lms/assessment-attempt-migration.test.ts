import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const describeDb = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDb('0028 assessment attempt migration', () => {
  it('upgrades foreign keys on pre-existing tables and remains idempotent', async () => {
    const pool = new Pool({ connectionString: process.env['DATABASE_URL']! });
    const client = await pool.connect();
    const schema = `migration_0028_${randomUUID().replaceAll('-', '')}`;

    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      await client.query(`
        CREATE TABLE share_links (id uuid PRIMARY KEY);
        CREATE TABLE generated_questions (id uuid PRIMARY KEY);
        CREATE TABLE assessment_attempts (
          id uuid PRIMARY KEY, share_link_id uuid NOT NULL REFERENCES share_links(id),
          workspace_id text NOT NULL, assessment_id text NOT NULL, guest_name text NOT NULL,
          guest_class text, status text NOT NULL DEFAULT 'in_progress', started_at timestamptz NOT NULL DEFAULT now(),
          last_saved_at timestamptz NOT NULL DEFAULT now(), submitted_at timestamptz, raw_score integer,
          max_score integer, needs_grading boolean NOT NULL DEFAULT false
        );
        CREATE TABLE assessment_attempt_answers (
          id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES assessment_attempts(id) ON DELETE CASCADE,
          question_id uuid NOT NULL, value text NOT NULL, is_correct boolean, score integer,
          needs_grading boolean NOT NULL DEFAULT false, graded_at timestamptz, UNIQUE (attempt_id, question_id)
        );
      `);
      const migration = await readFile(
        'src/infrastructure/database/migrations/0028_assessment_attempts.sql',
        'utf8',
      );

      await client.query(migration);
      await client.query(migration);

      const { rows } = await client.query<{ conname: string; definition: string }>(
        `
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE connamespace = $1::regnamespace
          AND conname IN ('assessment_attempts_share_link_id_fkey', 'assessment_attempt_answers_question_id_fkey')
        ORDER BY conname
      `,
        [schema],
      );
      expect(rows).toEqual([
        {
          conname: 'assessment_attempt_answers_question_id_fkey',
          definition:
            'FOREIGN KEY (question_id) REFERENCES generated_questions(id) ON DELETE RESTRICT',
        },
        {
          conname: 'assessment_attempts_share_link_id_fkey',
          definition: 'FOREIGN KEY (share_link_id) REFERENCES share_links(id) ON DELETE RESTRICT',
        },
      ]);
    } finally {
      client.release();
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  });
});
