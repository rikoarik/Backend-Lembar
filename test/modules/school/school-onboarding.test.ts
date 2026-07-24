/**
 * B7-03 — Teacher onboarding tests.
 *
 * Evidence covered:
 * - GET /v1/school/onboarding/status returns not_started bila belum ada record
 * - POST /v1/school/onboarding/complete mengubah status ke completed
 * - complete() idempotent: panggil dua kali → tetap completed, completedAt tidak berubah
 * - Transisi status: not_started → completed (skip in_progress via API)
 * - Isolasi user: teacher A tidak bisa lihat status teacher B
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';

import { TeacherOnboardingService } from '../../../src/modules/school/application/TeacherOnboardingService.js';
import { registerOnboardingRoutes } from '../../../src/modules/school/adapters/http/onboardingRoutes.js';
import type { TeacherOnboardingStore } from '../../../src/modules/school/application/TeacherOnboardingService.js';
import type { TeacherOnboardingRecord } from '../../../src/modules/school/domain/types.js';

// ─── In-memory store ──────────────────────────────────────────────────────────

class InMemoryOnboardingStore implements TeacherOnboardingStore {
  private records = new Map<string, TeacherOnboardingRecord>();

  private key(userId: string, workspaceId: string): string {
    return `${userId}::${workspaceId}`;
  }

  async findRecord(userId: string, workspaceId: string): Promise<TeacherOnboardingRecord | null> {
    return this.records.get(this.key(userId, workspaceId)) ?? null;
  }

  async upsertRecord(record: TeacherOnboardingRecord): Promise<TeacherOnboardingRecord> {
    this.records.set(this.key(record.userId, record.workspaceId), record);
    return record;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const USER_A = 'teacher-001';
const USER_B = 'teacher-002';
const WS = 'ws-sekolah-1';

function buildApp(store: InMemoryOnboardingStore) {
  const app = Fastify({ logger: false });
  const service = new TeacherOnboardingService(store);
  void registerOnboardingRoutes(app, { onboardingService: service });
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('B7-03 — Teacher onboarding', () => {
  let store: InMemoryOnboardingStore;

  beforeEach(() => {
    store = new InMemoryOnboardingStore();
  });

  describe('GET /v1/school/onboarding/status', () => {
    it('returns not_started bila belum pernah onboarding', async () => {
      const app = buildApp(store);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/school/onboarding/status',
        headers: { 'x-user-id': USER_A, 'x-workspace-id': WS },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.status).toBe('not_started');
      expect(body.data.userId).toBe(USER_A);
      expect(body.data.workspaceId).toBe(WS);
      expect(body.data.completedAt).toBeNull();
    });

    it('returns 400 bila x-user-id tidak ada', async () => {
      const app = buildApp(store);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/school/onboarding/status',
        headers: { 'x-workspace-id': WS },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    });

    it('returns 400 bila x-workspace-id tidak ada', async () => {
      const app = buildApp(store);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/school/onboarding/status',
        headers: { 'x-user-id': USER_A },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /v1/school/onboarding/complete', () => {
    it('mengubah status ke completed dan set completedAt', async () => {
      const app = buildApp(store);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/school/onboarding/complete',
        headers: { 'x-user-id': USER_A, 'x-workspace-id': WS },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.status).toBe('completed');
      expect(body.data.userId).toBe(USER_A);
      expect(body.data.completedAt).not.toBeNull();
    });

    it('GET status setelah complete mengembalikan completed', async () => {
      const app = buildApp(store);

      // Complete dulu
      await app.inject({
        method: 'POST',
        url: '/v1/school/onboarding/complete',
        headers: { 'x-user-id': USER_A, 'x-workspace-id': WS },
      });

      // Cek status
      const statusRes = await app.inject({
        method: 'GET',
        url: '/v1/school/onboarding/status',
        headers: { 'x-user-id': USER_A, 'x-workspace-id': WS },
      });
      expect(statusRes.statusCode).toBe(200);
      expect(statusRes.json().data.status).toBe('completed');
    });
  });

  describe('idempotency — complete() dipanggil dua kali', () => {
    it('completedAt tidak berubah pada panggilan kedua', async () => {
      const app = buildApp(store);

      // Panggil pertama
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/school/onboarding/complete',
        headers: { 'x-user-id': USER_A, 'x-workspace-id': WS },
      });
      const completedAt1 = res1.json().data.completedAt as string;

      // Tunggu 1ms agar clock bisa bergerak jika service tidak idempotent
      await new Promise((r) => setTimeout(r, 1));

      // Panggil kedua
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/school/onboarding/complete',
        headers: { 'x-user-id': USER_A, 'x-workspace-id': WS },
      });
      const completedAt2 = res2.json().data.completedAt as string;

      expect(res2.statusCode).toBe(200);
      expect(completedAt2).toBe(completedAt1); // tidak berubah
    });

    it('status tetap completed setelah panggilan berulang', async () => {
      const app = buildApp(store);

      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/school/onboarding/complete',
          headers: { 'x-user-id': USER_A, 'x-workspace-id': WS },
        });
        expect(res.json().data.status).toBe('completed');
      }
    });
  });

  describe('isolasi user', () => {
    it('teacher A dan teacher B punya status berbeda', async () => {
      const app = buildApp(store);

      // Complete untuk user A saja
      await app.inject({
        method: 'POST',
        url: '/v1/school/onboarding/complete',
        headers: { 'x-user-id': USER_A, 'x-workspace-id': WS },
      });

      // Status user B masih not_started
      const resB = await app.inject({
        method: 'GET',
        url: '/v1/school/onboarding/status',
        headers: { 'x-user-id': USER_B, 'x-workspace-id': WS },
      });
      expect(resB.json().data.status).toBe('not_started');
    });
  });
});
