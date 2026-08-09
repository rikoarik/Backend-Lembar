import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { InMemoryAdapter } from '../../../src/infrastructure/storage/InMemoryAdapter.js';
import { registerUploadsAuthHook } from '../../../src/modules/uploads/adapters/http/preHandler.js';
import { registerUploadRoutes } from '../../../src/modules/uploads/adapters/http/routes.js';
import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';

const secret = 'upload-hardening-secret';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const pdf = Buffer.from('%PDF-1.4\ntest\n%%EOF');
async function makeApp() { const app = Fastify(); await registerUploadsAuthHook(app, { jwtSecret: secret }); await registerUploadRoutes(app, { storage: new InMemoryAdapter() }); return app; }

describe('source upload JWT boundary', () => {
  it('rejects trusted-looking source headers without JWT', async () => {
    const app = await makeApp(); const response = await app.inject({ method: 'POST', url: '/v1/uploads/sources/intake', headers: { 'content-type': 'application/pdf', 'x-source-user-id': 'attacker', 'x-source-role': 'superadmin', 'x-workspace-id': workspaceId, 'x-tenant-id': workspaceId }, payload: pdf });
    expect(response.statusCode).toBe(401); await app.close();
  });
  it('derives upload identity and workspace from verified JWT despite spoof headers', async () => {
    const app = await makeApp(); const jwt = generateJwt({ userId: 'real-user', email: 'u@test', roles: ['teacher'], workspaceId }, { secret, expiryDays: 1 });
    const response = await app.inject({ method: 'POST', url: '/v1/uploads/sources/intake', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/pdf', 'x-source-user-id': 'attacker', 'x-source-role': 'subscriber', 'x-workspace-id': 'spoof', 'x-tenant-id': 'spoof' }, payload: pdf });
    expect(response.statusCode).toBe(201);
    const id = response.json().data.uploadId;
    const read = await app.inject({ method: 'GET', url: `/v1/uploads/sources/${id}`, headers: { authorization: `Bearer ${jwt}`, 'x-workspace-id': 'spoof' } });
    expect(read.statusCode).toBe(200);
    await app.close();
  });
});
