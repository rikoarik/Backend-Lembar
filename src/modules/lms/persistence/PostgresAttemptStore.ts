import { randomUUID } from 'node:crypto';
import type {
  DurableAttempt,
  DurableAttemptStore,
  gradeAnswers,
} from '../application/DurableAttemptService.js';
type Exec = { query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };
type Row = {
  id: string;
  share_link_id: string;
  workspace_id: string;
  assessment_id: string;
  guest_name: string;
  guest_class: string | null;
  status: 'in_progress' | 'submitted';
  started_at: Date | string;
  last_saved_at: Date | string;
  submitted_at: Date | string | null;
  raw_score: number | null;
  max_score: number | null;
  needs_grading: boolean;
  answers?: Record<string, string>;
};
const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
function map(r: Row): DurableAttempt {
  return {
    id: r.id,
    shareLinkId: r.share_link_id,
    workspaceId: r.workspace_id,
    assessmentId: r.assessment_id,
    guestName: r.guest_name,
    ...(r.guest_class ? { guestClass: r.guest_class } : {}),
    status: r.status,
    startedAt: iso(r.started_at),
    lastSavedAt: iso(r.last_saved_at),
    ...(r.submitted_at ? { submittedAt: iso(r.submitted_at) } : {}),
    ...(r.raw_score !== null ? { rawScore: r.raw_score } : {}),
    ...(r.max_score !== null ? { maxScore: r.max_score } : {}),
    needsGrading: r.needs_grading,
    answers: r.answers ?? {},
  };
}
export class PostgresAttemptStore implements DurableAttemptStore {
  constructor(private db: Exec) {}
  private async one(id: string) {
    const { rows } = await this.db.query<Row>(
      `SELECT a.*,COALESCE(jsonb_object_agg(x.question_id::text,x.value) FILTER (WHERE x.question_id IS NOT NULL),'{}') answers FROM assessment_attempts a LEFT JOIN assessment_attempt_answers x ON x.attempt_id=a.id WHERE a.id=$1 GROUP BY a.id`,
      [id],
    );
    return rows[0] ? map(rows[0]) : null;
  }
  async create(a: DurableAttempt) {
    const { rows } = await this.db.query<Row>(
      `INSERT INTO assessment_attempts(id,share_link_id,workspace_id,assessment_id,guest_name,guest_class) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [a.id, a.shareLinkId, a.workspaceId, a.assessmentId, a.guestName, a.guestClass ?? null],
    );
    return map(rows[0]!);
  }
  find(id: string) {
    return this.one(id);
  }
  async saveAnswers(id: string, answers: Record<string, string>) {
    const found = await this.one(id);
    if (!found || found.status === 'submitted') return found;
    for (const [q, v] of Object.entries(answers))
      await this.db.query(
        `INSERT INTO assessment_attempt_answers(id,attempt_id,question_id,value) VALUES($1,$2,$3::uuid,$4) ON CONFLICT(attempt_id,question_id) DO UPDATE SET value=EXCLUDED.value`,
        [randomUUID(), id, q, v],
      );
    await this.db.query(`UPDATE assessment_attempts SET last_saved_at=now() WHERE id=$1`, [id]);
    return this.one(id);
  }
  async submit(id: string, g: ReturnType<typeof gradeAnswers>) {
    for (const x of g.answers)
      await this.db.query(
        `INSERT INTO assessment_attempt_answers(id,attempt_id,question_id,value,is_correct,score,needs_grading,graded_at) VALUES($1,$2,$3::uuid,$4,$5,$6,$7,now()) ON CONFLICT(attempt_id,question_id) DO UPDATE SET value=EXCLUDED.value,is_correct=EXCLUDED.is_correct,score=EXCLUDED.score,needs_grading=EXCLUDED.needs_grading,graded_at=now()`,
        [randomUUID(), id, x.questionId, x.value, x.isCorrect, x.score, x.needsGrading],
      );
    await this.db.query(
      `UPDATE assessment_attempts SET status='submitted',submitted_at=COALESCE(submitted_at,now()),last_saved_at=now(),raw_score=$2,max_score=$3,needs_grading=$4 WHERE id=$1 AND status='in_progress'`,
      [id, g.rawScore, g.maxScore, g.needsGrading],
    );
    return this.one(id);
  }
  async results(w: string, a: string) {
    const { rows } = await this.db.query<Row>(
      `SELECT *, '{}'::jsonb answers FROM assessment_attempts WHERE workspace_id=$1 AND assessment_id=$2 AND status='submitted' ORDER BY submitted_at DESC`,
      [w, a],
    );
    return rows.map(map);
  }
}
