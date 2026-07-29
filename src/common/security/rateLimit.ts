import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { throwApiError } from '../errors/apiError.js';

type Entry = { count: number; resetAt: number };
const stores = new WeakMap<object, Map<string, Entry>>();

function compact(attempts: Map<string, Entry>, now: number): void {
  if (attempts.size < 10_000) return;
  for (const [key, entry] of attempts) if (entry.resetAt <= now) attempts.delete(key);
}

export function opaque(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 24);
}

export function rateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  scope: string,
  limit: number,
  windowMs: number,
): void {
  const now = Date.now();
  let attempts = stores.get(request.server);
  if (!attempts) {
    attempts = new Map<string, Entry>();
    stores.set(request.server, attempts);
  }
  compact(attempts, now);
  const key = `${scope}:${request.ip}`;
  const current = attempts.get(key);
  const entry = !current || current.resetAt <= now ? { count: 1, resetAt: now + windowMs } : { ...current, count: current.count + 1 };
  attempts.set(key, entry);
  if (entry.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    void reply.header('Retry-After', String(retryAfter));
    throwApiError('rate_limited', 'Terlalu banyak percobaan. Coba lagi nanti.', 429);
  }
}

export function clearRateLimit(request: FastifyRequest, scope: string): void {
  stores.get(request.server)?.delete(`${scope}:${request.ip}`);
}

// ponytail: limiter is process-local; move counters to Redis before running multiple API replicas.
export async function verifyTurnstile(request: FastifyRequest, token: unknown): Promise<void> {
  const secret = process.env['TURNSTILE_SECRET_KEY'];
  if (!secret || process.env['TURNSTILE_ENFORCED'] !== 'true') return;
  if (typeof token !== 'string' || !token) throwApiError('captcha_required', 'Verifikasi keamanan diperlukan.', 400);
  const body = new URLSearchParams({ secret, response: token, remoteip: request.ip });
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const result = await response.json() as { success?: boolean };
  if (!result.success) throwApiError('captcha_invalid', 'Verifikasi keamanan gagal.', 400);
}
