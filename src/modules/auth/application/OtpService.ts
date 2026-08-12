/**
 * OtpService — WhatsApp OTP: generate, store, verify.
 *
 * Rate limit: max 3 OTP per phone per 10 minutes (checked in DB).
 * Hash: bcrypt cost 8 (fast enough for 6-digit, slower than SHA for brute-force).
 * TTL: 10 minutes.
 */
import bcrypt from 'bcryptjs';
import { ApiError } from '../../../common/errors/envelope.js';
import { getPool, type Database } from '../../../infrastructure/database/db.js';

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RATE_WINDOW_MS = 10 * 60 * 1000;
const OTP_RATE_MAX = 3;
const BCRYPT_COST = 8;

// ponytail: OPENWA_BASE_URL is process.env — move to config schema when envs stabilise.
function openwaBase(): string {
  return (process.env['OPENWA_BASE_URL'] ?? 'http://172.21.0.3:2785').replace(/\/+$/, '');
}
function openwaKey(): string {
  return process.env['OPENWA_API_KEY'] ?? '';
}

export type OtpRequestResult = { expiresAt: Date };
export type OtpVerifyResult = { phone: string };

export class OtpService {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async request(phone: string): Promise<OtpRequestResult> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');

    const windowStart = new Date(this.now().getTime() - OTP_RATE_WINDOW_MS);
    const rateRes = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM otp_requests
       WHERE phone = $1 AND created_at > $2`,
      [phone, windowStart],
    );
    if (parseInt(rateRes.rows[0]?.count ?? '0', 10) >= OTP_RATE_MAX) {
      throw new ApiError({
        code: 'RATE_LIMITED',
        message: 'Terlalu banyak permintaan OTP. Coba lagi dalam 10 menit.',
        requestId: 'pending',
        status: 429,
      });
    }

    const code = String(Math.floor(100_000 + Math.random() * 900_000));
    const codeHash = await bcrypt.hash(code, BCRYPT_COST);
    const expiresAt = new Date(this.now().getTime() + OTP_TTL_MS);

    await pool.query(
      `INSERT INTO otp_requests (phone, code_hash, expires_at) VALUES ($1, $2, $3)`,
      [phone, codeHash, expiresAt],
    );

    await this.sendWhatsApp(phone, code);

    return { expiresAt };
  }

  async verify(phone: string, code: string): Promise<OtpVerifyResult> {
    const pool = getPool(this.db);
    if (!pool) throw new Error('Database not available');

    const res = await pool.query<{ id: string; code_hash: string }>(
      `SELECT id, code_hash FROM otp_requests
       WHERE phone = $1 AND used_at IS NULL AND expires_at > $2
       ORDER BY created_at DESC LIMIT 1`,
      [phone, this.now()],
    );
    const row = res.rows[0];
    if (!row) throw invalid('Kode OTP tidak valid atau sudah kedaluwarsa.');

    const match = await bcrypt.compare(code, row.code_hash);
    if (!match) throw invalid('Kode OTP salah.');

    await pool.query(`UPDATE otp_requests SET used_at = $1 WHERE id = $2`, [this.now(), row.id]);

    return { phone };
  }

  private async sendWhatsApp(phone: string, code: string): Promise<void> {
    const url = `${openwaBase()}/api/messages/send`;
    // ponytail: fire-and-forget — add delivery tracking when needed.
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': openwaKey(),
        },
        body: JSON.stringify({
          to: phone,
          message: `Kode OTP Lembar Anda: *${code}*\nBerlaku 10 menit. Jangan bagikan ke siapapun.`,
        }),
      });
      if (!res.ok) {
        // non-fatal — OTP is already stored; caller can retry send separately
        console.warn(`[OtpService] WA send failed: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      console.warn('[OtpService] WA send error:', err);
    }
  }
}

function invalid(message: string): ApiError {
  return new ApiError({ code: 'VALIDATION_FAILED', message, requestId: 'pending' });
}
