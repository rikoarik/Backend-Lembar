import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildApp, type BuildAppOptions } from '../../../src/bootstrap/app.js';
import { createDatabase, closeDatabase, type Database } from '../../../src/infrastructure/database/db.js';

function resolveDatabaseUrl(): string | null {
  if (process.env['DATABASE_URL']) return process.env['DATABASE_URL'];
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    const content = readFileSync(envPath, 'utf-8');
    const match = content.match(/^DATABASE_URL=(.+)$/m);
    if (match?.[1]) {
      process.env['DATABASE_URL'] = match[1];
      return match[1];
    }
  } catch { /* .env not readable */ }
  return null;
}

const DATABASE_URL = resolveDatabaseUrl();
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('JWT auth routes', () => {
  let db: Database;

  async function makeApp() {
    db = createDatabase({ connectionString: DATABASE_URL! });
    const app = await buildApp({
      logger: false,
      serviceName: 'test',
      serviceVersion: 'test',
      authDb: db,
    });
    return { app, db };
  }

  async function closeDb() {
    try { await closeDatabase(db); } catch { /* */ }
  }

  test('register creates subscriber user with full fields', async () => {
    const { app } = await makeApp();
    try {
      const ts = Date.now();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: `reg-${ts}@test.example`,
          password: 'Test1234!@#A',
          name: 'Tester',
          username: `tester${ts}`,
          phone: `0812${String(ts).slice(-8)}`,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toHaveProperty('token');
      expect(body).toHaveProperty('user');
      expect(body.user.roles).toContain('subscriber');
      expect(body.user.username).toBeTruthy();
      expect(body.user.phone).toBeTruthy();
    } finally {
      await app.close();
      await closeDb();
    }
  });

  test('register rejects duplicate email', async () => {
    const { app } = await makeApp();
    try {
      const ts = Date.now();
      const payload = {
        email: `dup-${ts}@test.example`,
        password: 'Test1234!@#A',
        name: 'Dup',
        username: `dupuser${ts}`,
        phone: `0812${String(ts + 1).slice(-8)}`,
      };
      await app.inject({ method: 'POST', url: '/v1/auth/register', payload });
      const dup = await app.inject({ method: 'POST', url: '/v1/auth/register', payload });

      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('STATE_CONFLICT');
    } finally {
      await app.close();
      await closeDb();
    }
  });

  test('login by email returns JWT token', async () => {
    const { app } = await makeApp();
    try {
      const ts = Date.now();
      await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: `login-${ts}@test.example`,
          password: 'Test1234!@#A',
          name: 'Login Test',
          username: `logintest${ts}`,
          phone: `0812${String(ts + 2).slice(-8)}`,
        },
      });

      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: `login-${ts}@test.example`, password: 'Test1234!@#A' },
      });

      expect(login.statusCode).toBe(200);
      expect(login.json().token).toBeTruthy();
      expect(login.json().user.email).toBe(`login-${ts}@test.example`);
    } finally {
      await app.close();
      await closeDb();
    }
  });

  test('login by username returns JWT token', async () => {
    const { app } = await makeApp();
    try {
      const ts = Date.now();
      const uname = `userlogin${ts}`;
      await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: `ulogin-${ts}@test.example`,
          password: 'Test1234!@#A',
          name: 'User Login',
          username: uname,
          phone: `0812${String(ts + 3).slice(-8)}`,
        },
      });

      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { identifier: uname, password: 'Test1234!@#A' },
      });

      expect(login.statusCode).toBe(200);
      expect(login.json().user.username).toBe(uname);
    } finally {
      await app.close();
      await closeDb();
    }
  });

  test('login by phone returns JWT token', async () => {
    const { app } = await makeApp();
    try {
      const ts = Date.now();
      const phone = `0812${String(ts + 4).slice(-8)}`;
      await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: `plogin-${ts}@test.example`,
          password: 'Test1234!@#A',
          name: 'Phone Login',
          username: `plogin${ts}`,
          phone,
        },
      });

      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { identifier: phone, password: 'Test1234!@#A' },
      });

      expect(login.statusCode).toBe(200);
      expect(login.json().user.phone).toBeTruthy();
    } finally {
      await app.close();
      await closeDb();
    }
  });

  test('GET /v1/auth/me requires Bearer token', async () => {
    const { app } = await makeApp();
    try {
      const noToken = await app.inject({ method: 'GET', url: '/v1/auth/me' });
      expect(noToken.statusCode).toBe(401);
    } finally {
      await app.close();
      await closeDb();
    }
  });

  test('GET /v1/auth/me with valid token returns user info', async () => {
    const { app } = await makeApp();
    try {
      const ts = Date.now();
      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: `me-${ts}@test.example`,
          password: 'Test1234!@#A',
          name: 'Me Test',
          username: `metest${ts}`,
          phone: `0812${String(ts + 5).slice(-8)}`,
        },
      });

      const token = reg.json().token;
      const me = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(me.statusCode).toBe(200);
      expect(me.json().id).toBeTruthy();
      expect(me.json().email).toBe(`me-${ts}@test.example`);
    } finally {
      await app.close();
      await closeDb();
    }
  });
});
