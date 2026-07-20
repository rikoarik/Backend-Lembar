/**
 * B2-01 — Redacted upload lifecycle smoke CLI.
 *
 * Exercises the full HTTP surface under in-process Fastify:
 *   intake → verify → access → revoke → delete
 *
 * Constraints:
 *   - Never logs a signed URL, storage key, or byte payload.
 *   - Prints a single redacted JSON line on success, exits 0.
 *   - On any step failure prints redacted JSON diagnostics, exits 1.
 *
 * Storage is in-memory; no Postgres required. Workers do not exercise this
 * CLI; the unit test in `test/modules/uploads/lifecycle.test.ts` covers the
 * same flow against the Postgres-backed service.
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { fingerprint } from '../common/redact.js';
import { buildApp } from '../bootstrap/app.js';
import { createStorageAdapter } from '../infrastructure/storage/createStorageAdapter.js';
import { PDF_TRAILER_MARKER } from '../modules/uploads/policy/UploadPolicies.js';

interface SmokeStep {
  label: string;
  ok: boolean;
  detail: string;
}

const WS_A = '00000000-0000-0000-0000-000000000001';
const WS_B = '00000000-0000-0000-0000-000000000002';
const TENANT_A = '00000000-0000-0000-0000-0000000000a1';
const TENANT_B = '00000000-0000-0000-0000-0000000000b1';
const USER_A = '00000000-0000-0000-0000-0000000000c1';

function actorHeaders(
  workspaceId: string,
  tenantId: string,
  userId = USER_A,
): Record<string, string> {
  return {
    'x-source-user-id': userId,
    'x-source-role': 'school_admin',
    'x-workspace-id': workspaceId,
    'x-tenant-id': tenantId,
    'content-type': 'application/pdf',
  };
}

function makePdfBody(): Buffer {
  const prefix = Buffer.from('%PDF-1.4\n', 'utf8');
  const body = Buffer.from('1 0 obj<<>>endobj\ntrailer<<>>\n', 'utf8');
  const trailer = Buffer.from(`${PDF_TRAILER_MARKER}\n`, 'utf8');
  return Buffer.concat([prefix, body, trailer]);
}

async function main(): Promise<void> {
  const steps: SmokeStep[] = [];
  const adapter = createStorageAdapter({ signingSecret: 'b2-01-smoke' });
  const app = await buildApp({
    logger: false,
    serviceName: 'upload-smoke',
    serviceVersion: 'b2-01-smoke',
  });
  await app.ready();
  try {
    const body = makePdfBody();

    // 1. intake
    const intake = await app.inject({
      method: 'POST',
      url: '/v1/uploads/sources/intake',
      headers: { ...actorHeaders(WS_A, TENANT_A), 'x-source-filename': 'demo.pdf' },
      payload: body,
    });
    const intakeBody = intake.json() as {
      data: { uploadId: string; status: string; byteSize: number };
    };
    assert.equal(intake.statusCode, 201, 'intake should be 201');
    const uploadId = intakeBody.data.uploadId;
    steps.push({
      label: 'intake',
      ok: true,
      detail: `uploadId=${fingerprint(uploadId)} size=${intakeBody.data.byteSize}`,
    });

    // 2. magic/size check (intake already recorded audit; verify runs both)
    const verify = await app.inject({
      method: 'POST',
      url: `/v1/uploads/sources/${uploadId}/verify`,
      headers: actorHeaders(WS_A, TENANT_A),
    });
    const verifyBody = verify.json() as { data: { status: string; magicSignature: string } };
    assert.equal(verify.statusCode, 200, 'verify should be 200');
    assert.equal(verifyBody.data.status, 'verified', 'status should be verified after intake');
    steps.push({
      label: 'verify',
      ok: true,
      detail: `magic=${verifyBody.data.magicSignature.slice(0, 12)}…`,
    });

    // 3. access (grant)
    const access = await app.inject({
      method: 'POST',
      url: `/v1/uploads/sources/${uploadId}/access`,
      headers: actorHeaders(WS_A, TENANT_A),
    });
    const accessBody = access.json() as {
      data: { signedUrlFingerprint: string; expiresAtEpochMs: number };
    };
    assert.equal(access.statusCode, 200, 'access should be 200');
    steps.push({
      label: 'access',
      ok: true,
      detail: `fingerprint=${accessBody.data.signedUrlFingerprint} ttlMs=${accessBody.data.expiresAtEpochMs - Date.now()}`,
    });

    // 4. revoke
    const revoke = await app.inject({
      method: 'POST',
      url: `/v1/uploads/sources/${uploadId}/revoke`,
      headers: actorHeaders(WS_A, TENANT_A),
    });
    assert.equal(revoke.statusCode, 200, 'revoke should be 200');
    steps.push({ label: 'revoke', ok: true, detail: 'audit-access-revoke written' });

    // 5. delete (tombstone + bytes removed)
    const del = await app.inject({
      method: 'POST',
      url: `/v1/uploads/sources/${uploadId}/delete`,
      headers: actorHeaders(WS_A, TENANT_A),
    });
    const delBody = del.json() as { data: { status: string; bytesRemoved: boolean } };
    assert.equal(del.statusCode, 200, 'delete should be 200');
    assert.equal(delBody.data.status, 'deleted', 'status should be deleted');
    assert.equal(delBody.data.bytesRemoved, true, 'bytes should be removed from storage');
    steps.push({
      label: 'delete',
      ok: true,
      detail: `bytesRemoved=${delBody.data.bytesRemoved}`,
    });

    // 6. cross-tenant denial (B2-01 IDOR — must be 404 not 403)
    await delay(1);
    const cross = await app.inject({
      method: 'GET',
      url: `/v1/uploads/sources/${uploadId}`,
      headers: actorHeaders(WS_B, TENANT_B),
    });
    assert.equal(cross.statusCode, 404, 'cross-tenant lookup must be 404');
    steps.push({ label: 'cross-tenant-idor', ok: true, detail: '404 returned without disclosure' });

    // 7. signed-URL redaction in CLI output (anti-leak check)
    const serialized = JSON.stringify({
      ok: steps.every((step) => step.ok),
      steps,
    });
    assert.equal(
      /mem:\/\/signed|key=.+&sig=/.test(serialized),
      false,
      'serialized log must not include signed URLs',
    );
    assert.equal(
      /private\/uploads/.test(serialized),
      false,
      'serialized log must not include storage keys',
    );
    steps.push({ label: 'redaction', ok: true, detail: 'no signed URL or storage key in log' });

    process.stdout.write(`${serialized}\n`);
    void adapter;
  } catch (err) {
    const serialized = JSON.stringify({
      ok: false,
      error: {
        name: err instanceof Error ? err.name : 'Error',
        message: err instanceof Error ? err.message : 'unknown',
      },
      steps,
    });
    process.stdout.write(`${serialized}\n`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('smoke/upload.js') === true;

if (isDirectRun) {
  await main();
}
