/**
 * B5-01 — A4 HTML template for print document.
 *
 * Simple string template (no external deps) that produces A4-sized HTML
 * suitable for browser print / puppeteer / wkhtmltopdf.
 *
 * Designed to be safe: all user content is HTML-escaped before insertion.
 */
import type { PrintDocument } from '../domain/PrintDocument.js';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderOptions(options: PrintDocument['questions'][0]['options']): string {
  if (!options || options.length === 0) return '';
  return `<ol type="A" class="options">${options
    .map((o) => `<li><span class="opt-key">${esc(o.key)}.</span> ${esc(o.text)}</li>`)
    .join('\n')}</ol>`;
}

function renderQuestion(q: PrintDocument['questions'][0], idx: number): string {
  return `
  <div class="question">
    <div class="q-header">
      <span class="q-num">${idx + 1}.</span>
      <span class="q-meta">[${esc(q.questionType.replace('_', ' '))} | ${esc(q.difficulty)}]</span>
    </div>
    <p class="stem">${esc(q.stem)}</p>
    ${renderOptions(q.options)}
  </div>`;
}

export function renderPrintHtml(doc: PrintDocument): string {
  const { meta, questions } = doc;
  const questionsHtml = questions.map((q, i) => renderQuestion(q, i)).join('\n');

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${esc(meta.title)}</title>
  <style>
    @page { size: A4; margin: 20mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Times New Roman', Times, serif; font-size: 12pt; color: #000; }
    .header { border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 16px; }
    .header h1 { font-size: 16pt; font-weight: bold; }
    .header .meta { font-size: 10pt; color: #555; margin-top: 4px; }
    .question { margin-bottom: 20px; page-break-inside: avoid; }
    .q-header { font-weight: bold; margin-bottom: 4px; }
    .q-num { margin-right: 6px; }
    .q-meta { font-size: 9pt; color: #666; font-weight: normal; }
    .stem { margin: 4px 0 8px 16px; }
    .options { margin-left: 32px; }
    .options li { margin-bottom: 2px; }
    .opt-key { font-weight: bold; }
    .footer { border-top: 1px solid #ccc; margin-top: 24px; padding-top: 8px; font-size: 9pt; color: #999; text-align: center; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>${esc(meta.title)}</h1>
    <div class="meta">
      Versi: ${esc(String(meta.assessmentVersion))} &nbsp;|&nbsp;
      Dihasilkan: ${esc(meta.generatedAt)} &nbsp;|&nbsp;
      Jumlah Soal: ${questions.length}
    </div>
  </div>

  <div class="questions">
    ${questionsHtml}
  </div>

  <div class="footer">
    Dokumen ini dibuat secara otomatis oleh Lembar &mdash; ${esc(meta.generatedAt)}
  </div>
</body>
</html>`;
}
