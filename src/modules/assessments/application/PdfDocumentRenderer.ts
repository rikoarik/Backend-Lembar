import PDFDocument from 'pdfkit';

import type { PrintDocument } from '../domain/PrintDocument.js';

export type PdfCopy = 'student' | 'teacher';

const FONT_REGULAR = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';

function line(
  doc: PDFKit.PDFDocument,
  text: string,
  options: PDFKit.Mixins.TextOptions = {},
): void {
  doc.font(FONT_REGULAR).fontSize(11).fillColor('#111111').text(text, options);
}

/**
 * Renders the content that sits directly below the school's letterhead.
 * The letterhead itself is intentionally outside this renderer so schools can
 * keep using their own approved kop without the exam title shifting position.
 */
export function examHeading(source: PrintDocument): string {
  switch (source.meta.assessmentType) {
    case 'practice':
      return 'LATIHAN SOAL';
    case 'daily':
      return 'ULANGAN HARIAN';
    case 'midterm':
      return 'UJIAN TENGAH SEMESTER';
    case 'final':
      return 'UJIAN AKHIR SEMESTER';
    case 'promotion':
      return 'UJIAN KENAIKAN KELAS';
    case 'tka':
      return 'TES KEMAMPUAN AKADEMIK';
    default:
      return `UJIAN ${source.meta.title}`.toUpperCase();
  }
}

export function academicYearLabel(source: PrintDocument): string | null {
  return source.meta.academicYear ? `TAHUN PELAJARAN ${source.meta.academicYear}` : null;
}

function renderExamHeader(doc: PDFKit.PDFDocument, source: PrintDocument, copy: PdfCopy): void {
  const copyLabel = copy === 'student' ? 'LEMBAR SOAL SISWA' : 'KUNCI JAWABAN GURU';
  const yearLabel = academicYearLabel(source);
  const subjectAndGrade = [source.meta.subjectLabel, source.meta.gradeLabel]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(' · ');

  doc.font(FONT_BOLD).fontSize(13).fillColor('#111111').text(examHeading(source), {
    align: 'center',
  });
  if (subjectAndGrade) {
    doc.font(FONT_REGULAR).fontSize(10).text(subjectAndGrade, { align: 'center' });
  }
  if (yearLabel) {
    doc.font(FONT_BOLD).fontSize(10).text(yearLabel, { align: 'center' });
  }
  doc.font(FONT_REGULAR).fontSize(9).text(copyLabel, { align: 'center' });
  doc.moveDown(0.5);
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .lineWidth(1)
    .strokeColor('#111111')
    .stroke();
  doc.moveDown(1);
}

function renderQuestionPrompt(
  doc: PDFKit.PDFDocument,
  question: PrintDocument['questions'][number],
  index: number,
): void {
  doc
    .font(FONT_BOLD)
    .fontSize(11)
    .fillColor('#111111')
    .text(`${index + 1}. `, {
      continued: true,
    });
  line(doc, question.stem);
  question.options.forEach((option) => line(doc, `${option.key}. ${option.text}`, { indent: 18 }));
}

function renderTeacherAnswer(
  doc: PDFKit.PDFDocument,
  question: PrintDocument['questions'][number],
): void {
  doc.font(FONT_BOLD).fontSize(10).fillColor('#111111').text('Jawaban: ', {
    indent: 18,
    continued: true,
  });
  doc.font(FONT_REGULAR).fontSize(10).text(question.answer);

  if (question.explanation.trim()) {
    doc.font(FONT_BOLD).fontSize(10).text('Pembahasan: ', {
      indent: 18,
      continued: true,
    });
    doc.font(FONT_REGULAR).fontSize(10).text(question.explanation);
  }
}

export async function renderAssessmentPdf(source: PrintDocument, copy: PdfCopy): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 56, compress: false });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  renderExamHeader(doc, source, copy);

  source.questions.forEach((question, index) => {
    renderQuestionPrompt(doc, question, index);
    if (copy === 'teacher') renderTeacherAnswer(doc, question);
    doc.moveDown(copy === 'teacher' ? 0.9 : 0.6);
  });

  doc.end();
  return done;
}
