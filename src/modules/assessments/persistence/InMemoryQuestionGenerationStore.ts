/**
 * B3-03 — In-memory implementation of QuestionGenerationStore.
 *
 * Used by unit tests and smoke; mirrors DB schema exactly.
 */
import type { GeneratedQuestion, QuestionGenerationStore } from '../domain/QuestionGeneration.js';

export class InMemoryQuestionGenerationStore implements QuestionGenerationStore {
  private readonly questions: GeneratedQuestion[] = [];

  async saveQuestions(questions: GeneratedQuestion[]): Promise<GeneratedQuestion[]> {
    const copies = questions.map(copyQuestion);
    this.questions.push(...copies);
    return copies.map(copyQuestion);
  }

  async getQuestionsByAssessmentVersionId(
    workspaceId: string,
    assessmentVersionId: string,
  ): Promise<GeneratedQuestion[]> {
    return this.questions
      .filter((q) => q.workspaceId === workspaceId && q.assessmentVersionId === assessmentVersionId)
      .map(copyQuestion);
  }

  async getQuestionById(
    workspaceId: string,
    questionId: string,
  ): Promise<GeneratedQuestion | null> {
    const q = this.questions.find((q) => q.workspaceId === workspaceId && q.id === questionId);
    if (!q) return null;
    return copyQuestion(q);
  }
}

function copyQuestion(question: GeneratedQuestion): GeneratedQuestion {
  return {
    ...question,
    options: question.options.map((option) => ({ ...option })),
    sourceIds: [...question.sourceIds],
    ...(question.image !== undefined
      ? { image: question.image ? { ...question.image } : null }
      : {}),
    versionMetadata: { ...question.versionMetadata },
  };
}
