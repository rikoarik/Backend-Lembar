export const QUALITY_REPORT_STATUSES = ['open', 'triaged', 'closed'] as const;
export type QualityReportStatus = (typeof QUALITY_REPORT_STATUSES)[number];

export const QUALITY_REPORT_NOTE_MAX_LENGTH = 1_000;

export type QualityReportUpdate = {
  status?: QualityReportStatus;
  expectedStatus?: QualityReportStatus;
  notes?: string;
};

type QualityReportUpdateValidation =
  | { ok: true; update: QualityReportUpdate }
  | { ok: false; code: 'VALIDATION_FAILED' | 'INVALID_STATUS_TRANSITION'; message: string };

export function validateQualityReportUpdate(input: {
  status?: unknown;
  expectedStatus?: unknown;
  notes?: unknown;
}): QualityReportUpdateValidation {
  const hasStatus = input.status !== undefined;
  const hasNotes = input.notes !== undefined;
  if (!hasStatus && !hasNotes) {
    return invalid('status atau notes wajib diisi.');
  }

  const update: QualityReportUpdate = {};
  if (hasStatus) {
    if (!isStatus(input.status) || !isStatus(input.expectedStatus)) {
      return invalid('status dan expectedStatus harus berupa status yang valid.');
    }
    if (!isAllowedTransition(input.expectedStatus, input.status)) {
      return {
        ok: false,
        code: 'INVALID_STATUS_TRANSITION',
        message: 'Transisi status report tidak valid.',
      };
    }
    update.status = input.status;
    update.expectedStatus = input.expectedStatus;
  }

  if (hasNotes) {
    if (typeof input.notes !== 'string') return invalid('notes harus berupa teks.');
    const notes = input.notes.trim();
    if (notes.length > QUALITY_REPORT_NOTE_MAX_LENGTH) {
      return invalid(`notes maksimal ${QUALITY_REPORT_NOTE_MAX_LENGTH} karakter.`);
    }
    update.notes = notes;
  }

  return { ok: true, update };
}

export function isAllowedTransition(from: QualityReportStatus, to: QualityReportStatus): boolean {
  return (
    (from === 'open' && (to === 'triaged' || to === 'closed')) ||
    (from === 'triaged' && to === 'closed')
  );
}

function isStatus(value: unknown): value is QualityReportStatus {
  return (
    typeof value === 'string' && QUALITY_REPORT_STATUSES.includes(value as QualityReportStatus)
  );
}

function invalid(message: string): QualityReportUpdateValidation {
  return { ok: false, code: 'VALIDATION_FAILED', message };
}
