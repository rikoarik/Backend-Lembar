import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerJobStatusRoutes } from '../../../src/modules/jobs/adapters/http/routes.js';
import { generateJwt } from '../../../src/modules/auth/infrastructure/jwtMultiRole.js';

const secret = 'job-status-hardening-secret';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const spoofed = '99999999-9999-4999-8999-999999999999';
const token = generateJwt({ userId: 'user-1', email: 'u@test', roles: ['teacher'], workspaceId }, { secret, expiryDays: 1 });
function service(calls: string[]) { return {
  async getStatus(_id: string, ctx: { workspaceId: string }) { calls.push(ctx.workspaceId); return { status: 'queued' }; },
  async cancel(_id: string, ctx: { workspaceId: string }, actor: string) { calls.push(ctx.workspaceId, actor); return { status: 'cancelled' }; },
  async recover(_id: string, ctx: { workspaceId: string }, actor: string) { calls.push(ctx.workspaceId, actor); return { status: 'queued' }; },
}; }

describe('job status HTTP JWT boundary', () => {
  for (const path of ['/v1/jobs/job-1', '/v1/jobs/job-1/cancel', '/v1/jobs/job-1/recover']) it(`${path} rejects spoof headers/query without JWT`, async () => {
    const app = Fastify(); registerJobStatusRoutes(app, service([]) as never, { jwtSecret: secret });
    const response = await app.inject({ method: path.endsWith('job-1') ? 'GET' : 'POST', url: `${path}?workspaceId=${spoofed}`, headers: { 'x-workspace-id': spoofed } });
    expect(response.statusCode).toBe(401); await app.close();
  });
  it('uses only verified JWT workspace and user for GET/cancel/recover', async () => {
    const calls: string[] = []; const app = Fastify(); registerJobStatusRoutes(app, service(calls) as never, { jwtSecret: secret });
    for (const [method, path] of [['GET', '/v1/jobs/job-1'], ['POST', '/v1/jobs/job-1/cancel'], ['POST', '/v1/jobs/job-1/recover']] as const) {
      const response = await app.inject({ method, url: `${path}?workspaceId=${spoofed}`, headers: { authorization: `Bearer ${token}`, 'x-workspace-id': spoofed } }); expect(response.statusCode).toBe(200);
    }
    expect(calls).toEqual([workspaceId, workspaceId, 'user-1', workspaceId, 'user-1']); await app.close();
  });
});
