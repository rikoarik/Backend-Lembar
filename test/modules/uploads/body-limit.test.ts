/**
 * BUG-18 — intake body-limit contract.
 *
 * Regression surface for the live failure where any source PDF above Fastify's
 * default 1 MiB body limit came back as `500 INTERNAL_ERROR` instead of a
 * `413` envelope (and unknown media types as 500 instead of 415).
 *
 * The route must honour `SOURCE_UPLOAD_MAX_BYTES` for both its body limit and
 * the `maxBytes` it advertises, and the app error handler must translate
 * Fastify's own content-type-parser errors into the stable envelope.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/bootstrap/app.js';
import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';
import { DEFAULT_SOURCE_UPLOAD_MAX_BYTES } from '../../../src/modules/uploads/policy/UploadPolicies.js';

const JWT_SECRET = 'dev-secret-change-in-production';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const INTAKE_URL = '/v1/uploads/sources/intake';

type App = Awaited<ReturnType<typeof buildApp>>;

const apps: App[] = [];
const previousMaxBytes = process.env['SOURCE_UPLOAD_MAX_BYTES'];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    if (app) await app.close();
  }
  if (previousMaxBytes === undefined) delete process.env['SOURCE_UPLOAD_MAX_BYTES'];
  else process.env['SOURCE_UPLOAD_MAX_BYTES'] = previousMaxBytes;
});

beforeEach(() => {
  delete process.env['SOURCE_UPLOAD_MAX_BYTES'];
});

async function makeApp(): Promise<App> {
  const app = await buildApp({ logger: false });
  await app.ready();
  apps.push(app);
  return app;
}

function token(): string {
  return generateJwt(
    { userId: 'user-body-limit', email: 'u@test', roles: ['teacher'], workspaceId: WORKSPACE_ID },
    { secret: JWT_SECRET, expiryDays: 1 },
  );
}

/** A byte-exact valid-looking PDF: `%PDF-` head, filler, `%%EOF` inside the tail window. */
function pdfOfSize(byteSize: number): Buffer {
  const head = Buffer.from('%PDF-1.4\n', 'utf8');
  const tail = Buffer.from('\n%%EOF\n', 'utf8');
  const filler = Buffer.alloc(Math.max(0, byteSize - head.length - tail.length), 0x20);
  return Buffer.concat([head, filler, tail]);
}

function intake(app: App, payload: Buffer, contentType = 'application/pdf') {
  return app.inject({
    method: 'POST',
    url: INTAKE_URL,
    headers: { authorization: `Bearer ${token()}`, 'content-type': contentType },
    payload,
  });
}

describe('BUG-18 intake body limit', () => {
  it('accepts a 2 MiB PDF (above the old 1 MiB Fastify default)', async () => {
    const app = await makeApp();
    const res = await intake(app, pdfOfSize(2 * 1024 * 1024));
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { byteSize: number; maxBytes: number } };
    expect(body.data.byteSize).toBe(2 * 1024 * 1024);
    expect(body.data.maxBytes).toBe(DEFAULT_SOURCE_UPLOAD_MAX_BYTES);
  });

  it('accepts a 10 MiB PDF', async () => {
    const app = await makeApp();
    const res = await intake(app, pdfOfSize(10 * 1024 * 1024));
    expect(res.statusCode).toBe(201);
  });

  it('accepts a PDF exactly at the advertised limit', async () => {
    process.env['SOURCE_UPLOAD_MAX_BYTES'] = '4096';
    const app = await makeApp();
    const res = await intake(app, pdfOfSize(4096));
    expect(res.statusCode).toBe(201);
    expect((res.json() as { data: { maxBytes: number } }).data.maxBytes).toBe(4096);
  });

  it('rejects a payload above the limit with a 413 envelope, not 500', async () => {
    process.env['SOURCE_UPLOAD_MAX_BYTES'] = '4096';
    const app = await makeApp();
    const res = await intake(app, pdfOfSize(4097));
    expect(res.statusCode).toBe(413);
    const body = res.json() as {
      error: { code: string; message: string; requestId: string; retryable: boolean };
    };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.retryable).toBe(false);
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it('maps an unsupported content type to 415 with an envelope', async () => {
    const app = await makeApp();
    const res = await intake(app, pdfOfSize(64), 'application/xml');
    expect(res.statusCode).toBe(415);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  it('maps text/plain on the intake path to 415 with an envelope', async () => {
    const app = await makeApp();
    const res = await intake(app, pdfOfSize(64), 'text/plain');
    expect(res.statusCode).toBe(415);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  it('still answers 401 without a token', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: INTAKE_URL,
      headers: { 'content-type': 'application/pdf' },
      payload: pdfOfSize(64),
    });
    expect(res.statusCode).toBe(401);
  });
});
