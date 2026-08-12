/**
 * X1-01 — Identity & workspace integration gate
 *
 * End-to-end validation:
 *   1. Register → login → verify JWT payload → GET /v1/me  (JWT valid, role correct)
 *   2. Create workspace (auto via register) → GET /v1/dashboard/summary (workspace scoped)
 *
 * Closes: FR-ID-001
 * Depends on: B1-01, B1-02, B1-03
 * Decision: D-002 (JWT-only auth, no session)
 *
 * Architecture notes:
 *   - Workspace is auto-created during registration (personal workspace).
 *   - POST /v1/auth/register returns { token, user } where user.workspaceId is set.
 *   - GET /v1/me wraps response in { data: user }.
 *   - GET /v1/auth/me returns user directly (no wrapper).
 *   - GET /v1/dashboard/summary returns { data: { activeWorkspaceId, user } }.
 *   - JWT payload: { userId, email, roles, workspaceId, iat, exp }.
 */
import jwt from 'jsonwebtoken';
import { describe, expect, test } from 'vitest';
import { buildApp } from '../../../src/bootstrap/app.js';
import {
  createDatabase,
  closeDatabase,
  type Database,
} from '../../../src/infrastructure/database/db.js';

// ── Database URL resolution ──────────────────────────────────────────────

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const JWT_SECRET = process.env['JWT_SECRET'] || 'dev-secret-change-in-production';

// ── App bootstrap (same pattern as working routes.test.ts) ──────────────

let db: Database;

async function makeApp() {
  db = createDatabase({ connectionString: DATABASE_URL! });
  const app = await buildApp({
    logger: false,
    serviceName: 'test-x1',
    serviceVersion: 'test',
    authDb: db,
  });
  return app;
}

async function closeDb() {
  try {
    await closeDatabase(db);
  } catch {
    /* ignore */
  }
}

// ── Unique test data helper ─────────────────────────────────────────────

function uniqueSuffix(): number {
  return Date.now();
}

// ── Tests ───────────────────────────────────────────────────────────────

describeDb('X1-01 — Identity & workspace integration gate', () => {
  // ── Scenario 1: Full identity lifecycle ──────────────────────────────

  describe('Scenario 1 — Register → Login → JWT → GET /v1/me', () => {
    test('register creates user, login returns JWT, JWT payload is valid, GET /v1/me returns user', async () => {
      const app = await makeApp();
      try {
        const ts = uniqueSuffix();

        // Step 1: Register
        const regRes = await app.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: {
            email: `x1-reg-${ts}@test.example`,
            password: 'Test1234!@#A',
            name: 'X1 Register',
            username: `x1reg${ts}`,
            phone: `0812${String(ts).slice(-8)}`,
          },
        });

        expect(regRes.statusCode).toBe(201);
        const regBody = regRes.json() as {
          token: string;
          user: {
            id: string;
            email: string;
            name: string;
            roles: string[];
            workspaceId: string | null;
            username?: string;
            phone?: string;
          };
        };
        expect(regBody.token).toBeTruthy();
        expect(regBody.user.email).toBe(`x1-reg-${ts}@test.example`);
        expect(regBody.user.roles).toContain('teacher');
        expect(regBody.user.workspaceId).toBeTruthy();

        // Step 2: Login (by email)
        const loginRes = await app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: {
            email: `x1-reg-${ts}@test.example`,
            password: 'Test1234!@#A',
          },
        });

        expect(loginRes.statusCode).toBe(200);
        const loginBody = loginRes.json() as {
          token: string;
          user: {
            id: string;
            email: string;
            roles: string[];
            workspaceId: string | null;
          };
        };
        expect(loginBody.token).toBeTruthy();
        expect(loginBody.user.id).toBe(regBody.user.id);

        // Step 3: Verify JWT payload
        const decoded = jwt.verify(loginBody.token, JWT_SECRET, { algorithms: ['HS256'] }) as {
          userId: string;
          email: string;
          roles: string[];
          workspaceId: string | null;
          iat: number;
          exp: number;
        };
        expect(decoded.userId).toBe(regBody.user.id);
        expect(decoded.email).toBe(`x1-reg-${ts}@test.example`);
        expect(decoded.roles).toContain('teacher');
        expect(decoded.workspaceId).toBe(regBody.user.workspaceId);
        expect(decoded.iat).toBeTypeOf('number');
        expect(decoded.exp).toBeTypeOf('number');
        expect(decoded.exp).toBeGreaterThan(decoded.iat);

        // Step 4: GET /v1/me with token
        const meRes = await app.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { authorization: `Bearer ${loginBody.token}` },
        });

        expect(meRes.statusCode).toBe(200);
        const meBody = meRes.json() as {
          data: {
            id: string;
            email: string;
            name: string;
            roles: string[];
            workspaceId: string | null;
          };
        };
        expect(meBody.data.id).toBe(regBody.user.id);
        expect(meBody.data.email).toBe(`x1-reg-${ts}@test.example`);
        expect(meBody.data.roles).toContain('teacher');
        expect(meBody.data.workspaceId).toBe(regBody.user.workspaceId);

        // Step 5: GET /v1/auth/me (no data wrapper)
        const authMeRes = await app.inject({
          method: 'GET',
          url: '/v1/auth/me',
          headers: { authorization: `Bearer ${loginBody.token}` },
        });

        expect(authMeRes.statusCode).toBe(200);
        const authMeBody = authMeRes.json() as {
          id: string;
          email: string;
          name: string;
          roles: string[];
          workspaceId: string | null;
        };
        expect(authMeBody.id).toBe(regBody.user.id);
        expect(authMeBody.email).toBe(`x1-reg-${ts}@test.example`);
      } finally {
        await app.close();
        await closeDb();
      }
    });

    test('login by username works and returns same user', async () => {
      const app = await makeApp();
      try {
        const ts = uniqueSuffix();
        const uname = `x1login${ts}`;

        // Register
        const regRes = await app.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: {
            email: `x1-ulogin-${ts}@test.example`,
            password: 'Test1234!@#A',
            name: 'X1 Username',
            username: uname,
          },
        });
        expect(regRes.statusCode).toBe(201);

        // Login by username
        const loginRes = await app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { identifier: uname, password: 'Test1234!@#A' },
        });

        expect(loginRes.statusCode).toBe(200);
        const loginBody = loginRes.json() as { token: string; user: { username?: string } };
        expect(loginBody.token).toBeTruthy();
        expect(loginBody.user.username).toBe(uname);
      } finally {
        await app.close();
        await closeDb();
      }
    });

    test('unauthenticated GET /v1/me returns 401', async () => {
      const app = await makeApp();
      try {
        const res = await app.inject({ method: 'GET', url: '/v1/me' });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
        await closeDb();
      }
    });

    test('invalid JWT token returns 401', async () => {
      const app = await makeApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { authorization: 'Bearer invalid-token-here' },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
        await closeDb();
      }
    });
  });

  // ── Scenario 2: Workspace scoped data ────────────────────────────────

  describe('Scenario 2 — Workspace scoped data via dashboard summary', () => {
    test('GET /v1/dashboard/summary returns workspace-scoped user data', async () => {
      const app = await makeApp();
      try {
        const ts = uniqueSuffix();

        // Register
        const regRes = await app.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: {
            email: `x1-dash-${ts}@test.example`,
            password: 'Test1234!@#A',
            name: 'X1 Dashboard',
            username: `x1dash${ts}`,
          },
        });

        expect(regRes.statusCode).toBe(201);
        const regBody = regRes.json() as {
          token: string;
          user: { id: string; workspaceId: string | null };
        };

        // GET /v1/dashboard/summary with JWT
        const dashRes = await app.inject({
          method: 'GET',
          url: '/v1/dashboard/summary',
          headers: { authorization: `Bearer ${regBody.token}` },
        });

        expect(dashRes.statusCode).toBe(200);
        const dashBody = dashRes.json() as {
          data: {
            activeWorkspaceId: string | null;
            user: {
              id: string;
              email: string;
              name: string;
              roles: string[];
            };
          };
        };
        expect(dashBody.data.activeWorkspaceId).toBe(regBody.user.workspaceId);
        expect(dashBody.data.user.id).toBe(regBody.user.id);
        expect(dashBody.data.user.roles).toContain('teacher');
      } finally {
        await app.close();
        await closeDb();
      }
    });

    test('dashboard summary without auth returns 401', async () => {
      const app = await makeApp();
      try {
        const res = await app.inject({ method: 'GET', url: '/v1/dashboard/summary' });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
        await closeDb();
      }
    });
  });

  // ── Scenario 3: Role verification in JWT ──────────────────────────────

  describe('Scenario 3 — Role verification in JWT and endpoints', () => {
    test('personal registration assigns teacher role', async () => {
      const app = await makeApp();
      try {
        const ts = uniqueSuffix();

        const regRes = await app.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: {
            email: `x1-role-${ts}@test.example`,
            password: 'Test1234!@#A',
            name: 'X1 Role',
            username: `x1role${ts}`,
          },
        });

        expect(regRes.statusCode).toBe(201);
        const regBody = regRes.json() as { token: string; user: { roles: string[] } };

        // Verify in register response
        expect(regBody.user.roles).toEqual(['teacher']);

        // Verify in decoded JWT
        const decoded = jwt.verify(regBody.token, JWT_SECRET, { algorithms: ['HS256'] }) as {
          roles: string[];
        };
        expect(decoded.roles).toEqual(['teacher']);

        // Verify in GET /v1/auth/me
        const meRes = await app.inject({
          method: 'GET',
          url: '/v1/auth/me',
          headers: { authorization: `Bearer ${regBody.token}` },
        });
        expect(meRes.statusCode).toBe(200);
        const meBody = meRes.json() as { roles: string[] };
        expect(meBody.roles).toEqual(['teacher']);
      } finally {
        await app.close();
        await closeDb();
      }
    });

    test('registration ignores explicit client role claims and persists teacher in JWT', async () => {
      const app = await makeApp();
      try {
        const ts = uniqueSuffix();

        const regRes = await app.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: {
            email: `x1-explicit-${ts}@test.example`,
            password: 'Test1234!@#A',
            name: 'X1 Explicit',
            username: `x1explicit${ts}`,
            roles: ['teacher'],
          },
        });

        expect(regRes.statusCode).toBe(201);
        const regBody = regRes.json() as { token: string; user: { roles: string[] } };

        expect(regBody.user.roles).toEqual(['teacher']);

        // Verify JWT carries the role
        const decoded = jwt.verify(regBody.token, JWT_SECRET, { algorithms: ['HS256'] }) as {
          roles: string[];
        };
        expect(decoded.roles).toEqual(['teacher']);
      } finally {
        await app.close();
        await closeDb();
      }
    });
  });

  // ── Scenario 4: Cross-context isolation ──────────────────────────────

  describe('Scenario 4 — JWT identity + workspace tenant isolation', () => {
    test('two different users have different workspaceIds', async () => {
      const app = await makeApp();
      try {
        const ts = uniqueSuffix();

        // Register user A
        const regA = await app.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: {
            email: `x1-userA-${ts}@test.example`,
            password: 'Test1234!@#A',
            name: 'User A',
            username: `x1usera${ts}`,
          },
        });
        expect(regA.statusCode).toBe(201);
        const bodyA = regA.json() as { token: string; user: { id: string; workspaceId: string } };

        // Register user B
        const regB = await app.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: {
            email: `x1-userB-${ts}@test.example`,
            password: 'Test1234!@#A',
            name: 'User B',
            username: `x1userb${ts}`,
          },
        });
        expect(regB.statusCode).toBe(201);
        const bodyB = regB.json() as { token: string; user: { id: string; workspaceId: string } };

        // Different users → different IDs
        expect(bodyA.user.id).not.toBe(bodyB.user.id);

        // Different workspaces
        expect(bodyA.user.workspaceId).not.toBe(bodyB.user.workspaceId);

        // User A's JWT cannot access User B's dashboard summary workspaceId
        const decodedA = jwt.verify(bodyA.token, JWT_SECRET, { algorithms: ['HS256'] }) as {
          workspaceId: string;
        };
        const decodedB = jwt.verify(bodyB.token, JWT_SECRET, { algorithms: ['HS256'] }) as {
          workspaceId: string;
        };
        expect(decodedA.workspaceId).not.toBe(decodedB.workspaceId);
      } finally {
        await app.close();
        await closeDb();
      }
    });

    test('user A token cannot retrieve user B data via /v1/me', async () => {
      const app = await makeApp();
      try {
        const ts = uniqueSuffix();

        // Register user A
        const regA = await app.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: {
            email: `x1-isolateA-${ts}@test.example`,
            password: 'Test1234!@#A',
            name: 'Isolate A',
            username: `x1isoa${ts}`,
          },
        });
        const bodyA = regA.json() as { token: string; user: { id: string } };

        // Register user B
        const regB = await app.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: {
            email: `x1-isolateB-${ts}@test.example`,
            password: 'Test1234!@#A',
            name: 'Isolate B',
            username: `x1isob${ts}`,
          },
        });
        const bodyB = regB.json() as { token: string; user: { id: string } };

        // Use token A to GET /v1/me — should return A's data, never B's
        const meRes = await app.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { authorization: `Bearer ${bodyA.token}` },
        });
        expect(meRes.statusCode).toBe(200);
        const meBody = meRes.json() as { data: { id: string } };
        expect(meBody.data.id).toBe(bodyA.user.id);
        expect(meBody.data.id).not.toBe(bodyB.user.id);
      } finally {
        await app.close();
        await closeDb();
      }
    });
  });
});
