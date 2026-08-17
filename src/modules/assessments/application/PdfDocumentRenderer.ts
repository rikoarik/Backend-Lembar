import PDFDocument from 'pdfkit';

import type { PrintDocument } from '../domain/PrintDocument.js';

export type PdfCopy = 'student' | 'teacher';

function line(doc: PDFKit.PDFDocument, text: string, options: PDFKit.Mixins.TextOptions = {}): void {
  doc.font('Helvetica').fontSize(11).fillColor('#111111').text(text, options);
}

export async function renderAssessmentPdf(source: PrintDocument, copy: PdfCopy): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 56, compress: false });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.font('Helvetica-Bold').fontSize(16).fillColor('#111111').text(source.meta.title);
  doc.moveDown(0.25);
  line(doc, copy === 'student' ? 'Lembar soal siswa' : 'Kunci guru');
  doc.moveDown();

  source.questions.forEach((question, index) => {
    doc.font('Helvetica-Bold').fontSize(11).text(`${index + 1}. `, { continued: true });
    line(doc, question.stem);
    question.options.forEach((option) => line(doc, `${option.key}. ${option.text}`, { indent: 18 }));
    doc.moveDown(0.6);
  });

  if (copy === 'teacher') {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(15).text('Kunci jawaban');
    doc.moveDown();
    source.questions.forEach((question, index) => line(doc, `${index + 1}. ${question.answer}`));
    doc.moveDown();
    doc.font('Helvetica-Bold').fontSize(15).text('Pembahasan');
    doc.moveDown();
    source.questions.forEach((question, index) => {
      doc.font('Helvetica-Bold').fontSize(11).text(`${index + 1}. `, { continued: true });
      line(doc, question.explanation);
      doc.moveDown(0.4);
    });
  }

  doc.end();
  return done;
}
