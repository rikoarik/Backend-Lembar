import { describe, expect, it } from 'vitest';

import {
  academicYearLabel,
  examHeading,
  renderAssessmentPdf,
} from '../../../src/modules/assessments/application/PdfDocumentRenderer.js';
import { PRINT_DTO_VERSION } from '../../../src/modules/assessments/domain/PrintDocument.js';

const doc = {
  meta: {
    dtoVersion: PRINT_DTO_VERSION,
    assessmentId: 'asm-1',
    assessmentVersion: 1,
    workspaceId: 'ws-1',
    title: 'Pecahan — Fase C',
    assessmentType: 'promotion',
    academicYear: '2026/2027',
    subjectLabel: 'Matematika',
    gradeLabel: 'Kelas 4',
    finalizedAt: '2026-08-17T00:00:00.000Z',
    generatedAt: '2026-08-17T00:00:00.000Z',
  },
  questions: [
    {
      sequence: 1,
      questionType: 'multiple_choice' as const,
      difficulty: 'easy' as const,
      stem: '1/2 + 1/4 = ...',
      options: [{ key: 'A', text: '3/4' }],
      answer: 'A',
      explanation: 'Samakan penyebut.',
    },
  ],
};

describe('renderAssessmentPdf', () => {
  it('renders a valid binary student PDF without teacher material', async () => {
    const pdf = await renderAssessmentPdf(doc, 'student');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('Helvetica');
    expect(examHeading(doc)).toBe('UJIAN KENAIKAN KELAS');
    expect(academicYearLabel(doc)).toBe('TAHUN PELAJARAN 2026/2027');
    expect(pdf.toString('latin1')).toContain('/Count 1');
  });

  it('renders a distinct teacher PDF with answer material in the first document section', async () => {
    const [studentPdf, teacherPdf] = await Promise.all([
      renderAssessmentPdf(doc, 'student'),
      renderAssessmentPdf(doc, 'teacher'),
    ]);

    expect(teacherPdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(teacherPdf.toString('latin1')).toContain('/Count 1');
    expect(teacherPdf.equals(studentPdf)).toBe(false);
    expect(teacherPdf.length).toBeGreaterThan(studentPdf.length);
  });
});
