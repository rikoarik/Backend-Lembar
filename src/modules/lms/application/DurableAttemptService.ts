import { randomUUID } from 'node:crypto';
import { ApiError } from '../../../common/errors/envelope.js';

export type PublicQuestion = { id: string; questionType: string; stem: string; options: unknown };
export type AuthoritativeQuestion = PublicQuestion & { answer: string; explanation?: string };
export type Graded = {
  questionId: string;
  value: string;
  isCorrect: boolean | null;
  score: number | null;
  needsGrading: boolean;
};
export type DurableAttempt = {
  id: string;
  shareLinkId: string;
  workspaceId: string;
  assessmentId: string;
  guestName: string;
  guestClass?: string;
  status: 'in_progress' | 'submitted';
  startedAt: string;
  lastSavedAt: string;
  submittedAt?: string;
  rawScore?: number;
  maxScore?: number;
  needsGrading: boolean;
  answers: Record<string, string>;
};
export interface DurableAttemptStore {
  create(a: DurableAttempt): Promise<DurableAttempt>;
  find(id: string): Promise<DurableAttempt | null>;
  saveAnswers(id: string, answers: Record<string, string>): Promise<DurableAttempt | null>;
  submit(id: string, grading: ReturnType<typeof gradeAnswers>): Promise<DurableAttempt | null>;
  results(workspaceId: string, assessmentId: string): Promise<DurableAttempt[]>;
}

export function sanitizePublicQuestions(q: AuthoritativeQuestion[]): PublicQuestion[] {
  return q.map(({ id, questionType, stem, options }) => ({ id, questionType, stem, options }));
}
export function gradeAnswers(values: Record<string, string>, questions: AuthoritativeQuestion[]) {
  let rawScore = 0,
    maxScore = 0,
    needsGrading = false;
  const answers: Graded[] = questions.map((q) => {
    const value = values[q.id] ?? '';
    const objective = q.questionType === 'multiple_choice' || q.questionType === 'true_false';
    if (!objective) {
      needsGrading = true;
      return { questionId: q.id, value, isCorrect: null, score: null, needsGrading: true };
    }
    maxScore++;
    const isCorrect = value === q.answer;
    const score = isCorrect ? 1 : 0;
    rawScore += score;
    return { questionId: q.id, value, isCorrect, score, needsGrading: false };
  });
  return { rawScore, maxScore, needsGrading, answers };
}
export class DurableAttemptService {
  constructor(private store: DurableAttemptStore) {}
  start(
    link: { id: string; workspaceId: string; assessmentId: string },
    guestName: string,
    guestClass?: string,
  ) {
    const now = new Date().toISOString();
    return this.store.create({
      id: randomUUID(),
      shareLinkId: link.id,
      workspaceId: link.workspaceId,
      assessmentId: link.assessmentId,
      guestName,
      ...(guestClass ? { guestClass } : {}),
      status: 'in_progress',
      startedAt: now,
      lastSavedAt: now,
      needsGrading: false,
      answers: {},
    });
  }
  async autosave(id: string, answers: Record<string, string>, shareLinkId?: string) {
    const current = await this.store.find(id);
    if (!current || (shareLinkId && current.shareLinkId !== shareLinkId)) throw this.notFound();
    const a = await this.store.saveAnswers(id, answers);
    if (!a) throw this.notFound();
    return a;
  }
  async submit(id: string, questions: AuthoritativeQuestion[], shareLinkId?: string) {
    const current = await this.store.find(id);
    if (!current || (shareLinkId && current.shareLinkId !== shareLinkId)) throw this.notFound();
    if (current.status === 'submitted') return current;
    const done = await this.store.submit(id, gradeAnswers(current.answers, questions));
    if (!done) throw this.notFound();
    return done;
  }
  results(w: string, a: string) {
    return this.store.results(w, a);
  }
  private notFound() {
    return new ApiError({
      code: 'RESOURCE_NOT_FOUND',
      message: 'Attempt tidak ditemukan.',
      requestId: 'unknown',
      status: 404,
    });
  }
}
