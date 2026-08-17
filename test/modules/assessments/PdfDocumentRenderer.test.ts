import { describe, expect, it } from 'vitest';

import { renderAssessmentPdf } from '../../../src/modules/assessments/application/PdfDocumentRenderer.js';
import { PRINT_DTO_VERSION } from '../../../src/modules/assessments/domain/PrintDocument.js';

const doc = {
  meta: {
    dtoVersion: PRINT_DTO_VERSION,
    assessmentId: 'asm-1',
    assessmentVersion: 1,
    workspaceId: 'ws-1',
    title: 'Pecahan',
    finalizedAt: '2026-08-17T00:00:00.000Z',
    generatedAt: '2026-08-17T00:00:00.000Z',
  },
  questions: [{
    sequence: 1,
    questionType: 'multiple_choice' as const,
    difficulty: 'easy' as const,
    stem: '1/2 + 1/4 = ...',
    options: [{ key: 'A', text: '3/4' }],
    answer: 'A',
    explanation: 'Samakan penyebut.',
  }],
};

describe('renderAssessmentPdf', () => {
  it('renders a valid binary student PDF without teacher material', async () => {
    const pdf = await renderAssessmentPdf(doc, 'student');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('/Count 1');
  });

  it('renders answer key and explanation only in the teacher PDF', async () => {
    const pdf = await renderAssessmentPdf(doc, 'teacher');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('/Count 2');
  });
});
