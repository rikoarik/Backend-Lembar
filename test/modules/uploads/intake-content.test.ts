/**
 * BUG-22 — HTTP contract for intake/verify content validation.
 *
 * The card's Definition of Done asks for HTTP evidence on four cases:
 *   1. valid PDF                    → 201 `received`, then verify 200 `verified`
 *   2. text body + `application/pdf` → 415 enveloped (was 201 before the fix)
 *   3. text body + `text/plain`      → 415 enveloped (was 500 before BUG-18)
 *   4. empty body + `application/pdf`→ 400 enveloped
 *
 * This is the in-process equivalent of the live `curl` probe; the same matrix
 * was re-run against BE 127.0.0.1:4000 after the fix.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/bootstrap/app.js';
import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';

const JWT_SECRET = 'dev-secret-change-in-production';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const INTAKE_URL = '/v1/uploads/sources/intake';

type App = Awaited<ReturnType<typeof buildApp>>;

const apps: App[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    if (app) await app.close();
  }
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
    { userId: 'user-bug22', email: 'u@test', roles: ['teacher'], workspaceId: WORKSPACE_ID },
    { secret: JWT_SECRET, expiryDays: 1 },
  );
}

/** Minimal valid PDF: `%PDF-` header plus a `%%EOF` trailer. */
function validPdf(): Buffer {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'utf8'),
    Buffer.from('1 0 obj<<>>endobj\ntrailer<<>>\n', 'utf8'),
    Buffer.from('%%EOF\n', 'utf8'),
  ]);
}

function intake(app: App, payload: Buffer, contentType = 'application/pdf') {
  return app.inject({
    method: 'POST',
    url: INTAKE_URL,
    headers: { authorization: `Bearer ${token()}`, 'content-type': contentType },
    payload,
  });
}

function verify(app: App, uploadId: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/uploads/sources/${uploadId}/verify`,
    headers: { authorization: `Bearer ${token()}` },
  });
}

interface Envelope {
  error: { code: string; message: string; requestId: string; retryable: boolean };
}

describe('BUG-22 intake/verify content validation over HTTP', () => {
  it('case 1 — a valid PDF is accepted and verifies cleanly', async () => {
    const app = await makeApp();
    const res = await intake(app, validPdf());
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { uploadId: string; status: string } };
    expect(body.data.status).toBe('received');

    const verified = await verify(app, body.data.uploadId);
    expect(verified.statusCode).toBe(200);
    const vBody = verified.json() as { data: { status: string; magicSignature: string } };
    expect(vBody.data.status).toBe('verified');
    expect(vBody.data.magicSignature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('case 2 — a text body sent as application/pdf is rejected with 415', async () => {
    const app = await makeApp();
    const res = await intake(app, Buffer.from('hello not a pdf', 'utf8'));
    expect(res.statusCode).toBe(415);
    const body = res.json() as Envelope;
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.retryable).toBe(false);
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it('case 2b — the longer "JUST TEXT" payload is rejected the same way', async () => {
    const app = await makeApp();
    const res = await intake(app, Buffer.from('JUST TEXT'.repeat(10), 'utf8'));
    expect(res.statusCode).toBe(415);
    expect((res.json() as Envelope).error.code).toBe('VALIDATION_FAILED');
  });

  it('case 3 — text/plain on the intake path is 415, not 500', async () => {
    const app = await makeApp();
    const res = await intake(app, Buffer.from('hello', 'utf8'), 'text/plain');
    expect(res.statusCode).toBe(415);
    expect((res.json() as Envelope).error.code).toBe('VALIDATION_FAILED');
  });

  it('case 4 — an empty body is rejected with 400', async () => {
    const app = await makeApp();
    const res = await intake(app, Buffer.from('', 'utf8'));
    expect(res.statusCode).toBe(400);
    expect((res.json() as Envelope).error.code).toBe('VALIDATION_FAILED');
  });
});
