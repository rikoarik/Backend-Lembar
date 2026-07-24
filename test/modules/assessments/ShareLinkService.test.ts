/**
 * B5-03 — Tests: Controlled share links.
 *
 * Evidence covered:
 * - high-entropy token: token is 64 hex chars (32 bytes)
 * - expiry enforced: expired link returns AUTH_REQUIRED (401)
 * - revocation works: revoked link returns AUTH_REQUIRED (401)
 * - tenant isolation: workspace B cannot revoke workspace A's link
 * - token not found: returns AUTH_REQUIRED (401)
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { ShareLinkService } from '../../../src/modules/assessments/application/ShareLinkService.js';
import { InMemoryShareLinkStore } from '../../../src/modules/assessments/persistence/InMemoryShareLinkStore.js';
import { ApiError } from '../../../src/common/errors/envelope.js';

const WS_A = 'ws-share-A';
const WS_B = 'ws-share-B';
const ASSESSMENT_ID = 'assessment-001';
const REQ_ID = 'req-test-001';

function makeService(overrides?: { clock?: () => Date; token?: () => string }) {
  const store = new InMemoryShareLinkStore();
  const service = new ShareLinkService({ store, ...overrides });
  return { store, service };
}

describe('ShareLinkService', () => {
  let store: InMemoryShareLinkStore;
  let service: ShareLinkService;

  beforeEach(() => {
    ({ store, service } = makeService());
  });

  describe('createShareLink', () => {
    it('generates a high-entropy token (64 hex chars = 32 bytes)', async () => {
      const link = await service.createShareLink({
        workspaceId: WS_A,
        assessmentId: ASSESSMENT_ID,
        requestId: REQ_ID,
      });
      expect(link.token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('sets expiresAt in the future (default 7 days)', async () => {
      const before = Date.now();
      const link = await service.createShareLink({
        workspaceId: WS_A,
        assessmentId: ASSESSMENT_ID,
        requestId: REQ_ID,
      });
      const expiresMs = new Date(link.expiresAt).getTime();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(expiresMs).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
    });

    it('respects custom ttlSeconds', async () => {
      const now = new Date('2025-01-01T00:00:00Z');
      const { service: svc } = makeService({ clock: () => now });
      const link = await svc.createShareLink({
        workspaceId: WS_A,
        assessmentId: ASSESSMENT_ID,
        requestId: REQ_ID,
        ttlSeconds: 3600,
      });
      expect(link.expiresAt).toBe('2025-01-01T01:00:00.000Z');
    });

    it('creates link scoped to workspace + assessment', async () => {
      const link = await service.createShareLink({
        workspaceId: WS_A,
        assessmentId: ASSESSMENT_ID,
        requestId: REQ_ID,
      });
      expect(link.workspaceId).toBe(WS_A);
      expect(link.assessmentId).toBe(ASSESSMENT_ID);
      expect(link.revokedAt).toBeNull();
    });
  });

  describe('validateToken', () => {
    it('returns link for valid active token', async () => {
      const created = await service.createShareLink({
        workspaceId: WS_A,
        assessmentId: ASSESSMENT_ID,
        requestId: REQ_ID,
      });
      const validated = await service.validateToken(created.token, REQ_ID);
      expect(validated.id).toBe(created.id);
    });

    it('throws AUTH_REQUIRED (401) for unknown token', async () => {
      await expect(service.validateToken('deadbeef'.repeat(8), REQ_ID)).rejects.toSatisfy(
        (e: unknown) => e instanceof ApiError && e.status === 401 && e.code === 'AUTH_REQUIRED',
      );
    });

    it('throws AUTH_REQUIRED (401) for expired token', async () => {
      const past = new Date('2020-01-01T00:00:00Z');
      const future = new Date('2020-01-02T00:00:00Z'); // still "future" at creation
      // Create with clock set to past so expiresAt is also in the past
      const { service: svc } = makeService({ clock: () => past });
      const link = await svc.createShareLink({
        workspaceId: WS_A,
        assessmentId: ASSESSMENT_ID,
        requestId: REQ_ID,
        ttlSeconds: 1, // expires 1s after creation in 2020
      });

      // Validate with clock set to "now" (after expiry)
      const nowService = new ShareLinkService({
        store: svc['options'].store,
        clock: () => future,
      });
      await expect(nowService.validateToken(link.token, REQ_ID)).rejects.toSatisfy(
        (e: unknown) => e instanceof ApiError && e.status === 401 && e.code === 'AUTH_REQUIRED',
      );
    });

    it('throws AUTH_REQUIRED (401) for revoked token', async () => {
      const link = await service.createShareLink({
        workspaceId: WS_A,
        assessmentId: ASSESSMENT_ID,
        requestId: REQ_ID,
      });
      await service.revokeShareLink(link.token, WS_A, REQ_ID);
      await expect(service.validateToken(link.token, REQ_ID)).rejects.toSatisfy(
        (e: unknown) => e instanceof ApiError && e.status === 401 && e.code === 'AUTH_REQUIRED',
      );
    });
  });

  describe('revokeShareLink', () => {
    it('revokes an active share link', async () => {
      const link = await service.createShareLink({
        workspaceId: WS_A,
        assessmentId: ASSESSMENT_ID,
        requestId: REQ_ID,
      });
      const revoked = await service.revokeShareLink(link.token, WS_A, REQ_ID);
      expect(revoked.revokedAt).not.toBeNull();
    });

    it('throws RESOURCE_NOT_FOUND (404) for unknown token', async () => {
      await expect(
        service.revokeShareLink('deadbeef'.repeat(8), WS_A, REQ_ID),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof ApiError && e.status === 404 && e.code === 'RESOURCE_NOT_FOUND',
      );
    });

    it('throws PERMISSION_DENIED (403) for wrong workspace (tenant isolation)', async () => {
      const link = await service.createShareLink({
        workspaceId: WS_A,
        assessmentId: ASSESSMENT_ID,
        requestId: REQ_ID,
      });
      await expect(
        service.revokeShareLink(link.token, WS_B, REQ_ID),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof ApiError && e.status === 403 && e.code === 'PERMISSION_DENIED',
      );
    });
  });

  describe('listByAssessment', () => {
    it('only returns links for the requesting workspace (tenant isolation)', async () => {
      await service.createShareLink({ workspaceId: WS_A, assessmentId: ASSESSMENT_ID, requestId: REQ_ID });
      await service.createShareLink({ workspaceId: WS_B, assessmentId: ASSESSMENT_ID, requestId: REQ_ID });

      const linksA = await service.listByAssessment(WS_A, ASSESSMENT_ID);
      const linksB = await service.listByAssessment(WS_B, ASSESSMENT_ID);

      expect(linksA).toHaveLength(1);
      expect(linksA[0]!.workspaceId).toBe(WS_A);
      expect(linksB).toHaveLength(1);
      expect(linksB[0]!.workspaceId).toBe(WS_B);
    });
  });
});
