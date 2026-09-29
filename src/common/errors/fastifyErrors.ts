import type { FastifyError } from 'fastify';

import type { StableErrorCode } from './envelope.js';

/**
 * BUG-18 — Fastify's own content-type-parser errors (body over `bodyLimit`,
 * unsupported media type, bad Content-Length, malformed JSON) are not
 * `ApiError`s, so they used to fall through to the generic 500 branch and be
 * logged as `unhandled error`. They are client errors and carry the correct
 * HTTP status on `err.statusCode`; map the whole family instead of one code so
 * the next parser error does not reintroduce the 500.
 */
export interface MappedFastifyError {
  status: number;
  code: StableErrorCode;
  message: string;
  retryable: boolean;
}

const CONTENT_TYPE_PARSER_PREFIX = 'FST_ERR_CTP_';

function messageFor(status: number): string {
  if (status === 413) return 'Ukuran berkas melebihi batas.';
  if (status === 415) return 'Tipe konten tidak didukung. Gunakan application/pdf.';
  return 'Permintaan tidak valid.';
}

export function mapFastifyError(err: FastifyError): MappedFastifyError | null {
  const code = typeof err.code === 'string' ? err.code : '';
  if (!code.startsWith(CONTENT_TYPE_PARSER_PREFIX)) return null;

  const declared = typeof err.statusCode === 'number' ? err.statusCode : 400;
  const status = declared >= 400 && declared < 500 ? declared : 400;

  return {
    status,
    code: 'VALIDATION_FAILED',
    message: messageFor(status),
    retryable: false,
  };
}
