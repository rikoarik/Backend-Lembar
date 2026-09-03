/**
 * AI Provider configuration routes — superadmin only.
 *
 * GET  /v1/admin/ai-provider        — read current config (API keys censored)
 * PATCH /v1/admin/ai-provider       — partial update of .env + pm2 restart
 * POST /v1/admin/ai-provider/test   — live connectivity test against a provider
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { createJwtAuthMiddleware, requireRole } from '../../../../common/middleware/jwtMultiRoleAuth.js';
import type { Database } from '../../../../infrastructure/database/db.js';

export interface RegisterAiProviderRoutesOptions {
  db: Database;
  jwtSecret: string;
}

/** Show only first 4 + *** + last 4 chars of an API key */
function censorKey(key: string | null | undefined): string {
  if (!key || key.length < 9) return key ? '***' : '';
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}

/** Returns true if the caller sent a placeholder / blank — don't overwrite */
function isPlaceholder(value: string | null | undefined): boolean {
  if (value === undefined || value === null) return true;
  const v = value.trim();
  return v === '' || v === '***' || v.includes('***');
}

/** Resolve .env path — walk up from cwd until we find it */
function findEnvPath(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: next to the dist folder
  return path.join(process.cwd(), '.env');
}

/** Read .env as a key→value map (preserves comments / ordering) */
function readEnvMap(envPath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(envPath)) return map;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    map.set(k, v);
  }
  return map;
}

/** Overwrite only the changed keys in .env, preserving all other lines */
function patchEnvFile(envPath: string, updates: Record<string, string>): void {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^(${key}=)(.*)$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `$1${value}`);
    } else {
      // Append
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  }
  fs.writeFileSync(envPath, content, 'utf8');
}

export async function registerAiProviderRoutes(
  app: FastifyInstance,
  options: RegisterAiProviderRoutesOptions,
): Promise<void> {
  const { db, jwtSecret } = options;
  const auth = createJwtAuthMiddleware({ secret: jwtSecret, db });
  const superadmin = requireRole(['superadmin']);

  // ── GET /v1/admin/ai-provider ────────────────────────────────────────────
  app.get('/v1/admin/ai-provider', { preHandler: [auth, superadmin] }, async (_request, reply) => {
    const env = process.env;

    return reply.status(200).send({
      data: {
        driver: env.AI_DRIVER ?? 'mock',
        // Primary (hermes / custom OpenAI-compatible)
        primaryBaseUrl: env.HERMES_BASE_URL ?? '',
        primaryApiKey: censorKey(env.HERMES_API_KEY),
        primaryModelId: env.AI_MODEL_ID ?? '',
        // Fallback (openai)
        fallbackBaseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com',
        fallbackApiKey: censorKey(env.OPENAI_API_KEY),
        fallbackModelId: env.OPENAI_MODEL_ID ?? 'gpt-4o-mini',
        timeoutMs: Number(env.AI_TIMEOUT_MS ?? 30000),
        maxTokens: Number(env.AI_MAX_TOKENS ?? 4096),
        imageEnabled: env.AI_IMAGE_ENABLED === 'true' || env.AI_IMAGE_ENABLED === '1',
        imageBaseUrl: env.AI_IMAGE_BASE_URL ?? 'https://api.x.ai/v1',
        imageApiKey: censorKey(env.AI_IMAGE_API_KEY),
        imageModelId: env.AI_IMAGE_MODEL_ID ?? 'grok-imagine-image',
        runtime: 'hermes',
        // Runtime status
        apiKeyPresent: Boolean(env.HERMES_API_KEY || env.OPENAI_API_KEY),
      },
    });
  });

  // ── PATCH /v1/admin/ai-provider ──────────────────────────────────────────
  app.patch('/v1/admin/ai-provider', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const body = request.body as {
      driver?: string;
      primaryBaseUrl?: string;
      primaryApiKey?: string;
      primaryModelId?: string;
      fallbackBaseUrl?: string;
      fallbackApiKey?: string;
      fallbackModelId?: string;
      timeoutMs?: number;
      maxTokens?: number;
      imageEnabled?: boolean;
      imageBaseUrl?: string;
      imageApiKey?: string;
      imageModelId?: string;
    } | undefined;

    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Body kosong.' } });
    }

    const allowed = new Set(['mock', 'openai', 'hermes']);
    if (body.driver !== undefined && !allowed.has(body.driver)) {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: `driver harus salah satu dari: ${[...allowed].join(', ')}` },
      });
    }

    const updates: Record<string, string> = {};

    if (body.driver !== undefined) updates['AI_DRIVER'] = body.driver;
    if (!isPlaceholder(body.primaryBaseUrl)) updates['HERMES_BASE_URL'] = body.primaryBaseUrl!.trim();
    if (!isPlaceholder(body.primaryApiKey)) updates['HERMES_API_KEY'] = body.primaryApiKey!.trim();
    if (!isPlaceholder(body.primaryModelId)) updates['AI_MODEL_ID'] = body.primaryModelId!.trim();
    if (!isPlaceholder(body.fallbackBaseUrl)) updates['OPENAI_BASE_URL'] = body.fallbackBaseUrl!.trim();
    if (!isPlaceholder(body.fallbackApiKey)) updates['OPENAI_API_KEY'] = body.fallbackApiKey!.trim();
    if (!isPlaceholder(body.fallbackModelId)) updates['OPENAI_MODEL_ID'] = body.fallbackModelId!.trim();
    if (body.timeoutMs !== undefined && Number.isFinite(body.timeoutMs)) {
      updates['AI_TIMEOUT_MS'] = String(body.timeoutMs);
    }
    if (body.maxTokens !== undefined && Number.isInteger(body.maxTokens) && body.maxTokens >= 1 && body.maxTokens <= 65_536) {
      updates['AI_MAX_TOKENS'] = String(body.maxTokens);
    }
    if (body.imageEnabled !== undefined && typeof body.imageEnabled === 'boolean') updates['AI_IMAGE_ENABLED'] = String(body.imageEnabled);
    if (!isPlaceholder(body.imageBaseUrl)) updates['AI_IMAGE_BASE_URL'] = body.imageBaseUrl!.trim();
    if (!isPlaceholder(body.imageApiKey)) updates['AI_IMAGE_API_KEY'] = body.imageApiKey!.trim();
    if (!isPlaceholder(body.imageModelId)) updates['AI_IMAGE_MODEL_ID'] = body.imageModelId!.trim();

    if (Object.keys(updates).length === 0) {
      return reply.status(200).send({ data: { updated: false, message: 'Tidak ada field yang berubah.' } });
    }

    // Patch .env on disk
    const envPath = findEnvPath();
    try {
      patchEnvFile(envPath, updates);
    } catch (err) {
      app.log.error({ err }, 'Failed to patch .env');
      return reply.status(500).send({ error: { code: 'ENV_WRITE_FAILED', message: 'Gagal menulis .env.' } });
    }

    // Apply to current process.env so the running instance reflects changes immediately
    for (const [k, v] of Object.entries(updates)) {
      process.env[k] = v;
    }

    // Reload PM2 workers (best-effort — may not be running in dev)
    try {
      execSync('pm2 restart lembar-worker --update-env 2>/dev/null || true', { timeout: 15_000 });
    } catch {
      /* non-fatal */
    }

    // Audit log (best-effort)
    try {
      const actor = (request as any).jwtUser;
      if (actor?.userId) {
        // omit key values from audit metadata
        const safeUpdates = Object.fromEntries(
          Object.entries(updates).map(([k, v]) => [k, k.toLowerCase().includes('key') ? censorKey(v) : v]),
        );
        app.log.info({ actor: actor.userId, updates: safeUpdates }, 'ai-provider config updated');
      }
    } catch { /* best-effort */ }

    return reply.status(200).send({ data: { updated: true, fields: Object.keys(updates) } });
  });

  // ── POST /v1/admin/ai-provider/test ──────────────────────────────────────
  app.post('/v1/admin/ai-provider/test', { preHandler: [auth, superadmin] }, async (request, reply) => {
    const body = request.body as {
      target?: 'primary' | 'fallback';
      baseUrl?: string;
      apiKey?: string;
      modelId?: string;
    } | undefined;

    const target = body?.target ?? 'primary';

    // Resolve credentials: prefer request body (allows testing before saving),
    // fall back to current env
    const rawBaseUrl =
      !isPlaceholder(body?.baseUrl)
        ? body!.baseUrl!.trim()
        : target === 'primary'
          ? (process.env.HERMES_BASE_URL ?? '')
          : (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com');

    const rawApiKey =
      !isPlaceholder(body?.apiKey)
        ? body!.apiKey!.trim()
        : target === 'primary'
          ? (process.env.HERMES_API_KEY ?? '')
          : (process.env.OPENAI_API_KEY ?? '');

    const modelId =
      !isPlaceholder(body?.modelId)
        ? body!.modelId!.trim()
        : target === 'primary'
          ? (process.env.AI_MODEL_ID ?? 'gpt-3.5-turbo')
          : (process.env.OPENAI_MODEL_ID ?? 'gpt-4o-mini');

    if (!rawBaseUrl) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Base URL tidak boleh kosong.' } });
    }
    if (!rawApiKey) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'API key tidak boleh kosong.' } });
    }

    const baseUrl = rawBaseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/chat/completions`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);

      const resp = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${rawApiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      clearTimeout(timer);

      const text = await resp.text().catch(() => '');

      if (resp.ok) {
        return reply.status(200).send({
          data: { ok: true, status: resp.status, message: 'Koneksi berhasil.' },
        });
      }

      // Parse error body if possible
      let errMsg = `HTTP ${resp.status}`;
      try {
        const parsed = JSON.parse(text) as any;
        errMsg = parsed?.error?.message ?? parsed?.message ?? errMsg;
      } catch { /* use raw status */ }

      return reply.status(200).send({
        data: { ok: false, status: resp.status, message: errMsg },
      });
    } catch (err: any) {
      const isTimeout = err?.name === 'AbortError';
      return reply.status(200).send({
        data: {
          ok: false,
          status: 0,
          message: isTimeout ? 'Timeout — provider tidak merespons dalam 15 detik.' : String(err?.message ?? err),
        },
      });
    }
  });
}
