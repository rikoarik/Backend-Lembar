import { createHash, createHmac, randomUUID } from 'node:crypto';

import { fingerprint } from '../../common/redact.js';
import type {
  HeadObjectResult,
  PutObjectInput,
  PutObjectResult,
  SignedUrl,
  SignedUrlOptions,
  StorageAdapter,
} from './StorageAdapter.js';

interface StoredObject {
  body: Buffer;
  contentType: string;
  cacheControlSeconds: number | undefined;
  checksumSha256: string;
}

interface PendingSignedUrl {
  key: string;
  expiresAtEpochMs: number;
  responseContentDisposition: string | undefined;
}

/**
 * In-memory adapter for tests and spike-mode local runs. Objects live in
 * process memory only and are dropped on process exit.
 */
export class InMemoryAdapter implements StorageAdapter {
  private readonly objects = new Map<string, StoredObject>();
  private readonly signed = new Map<string, PendingSignedUrl>();
  private readonly signingSecret: string;
  private readonly clock: () => number;

  constructor(opts: { signingSecret?: string; clock?: () => number } = {}) {
    this.signingSecret = opts.signingSecret ?? randomUUID();
    this.clock = opts.clock ?? (() => Date.now());
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const body = toBuffer(input.body);
    const contentType = input.contentType ?? 'application/octet-stream';
    const checksumSha256 = sha256Hex(body);
    this.objects.set(input.key, {
      body,
      contentType,
      cacheControlSeconds: input.cacheControlSeconds,
      checksumSha256,
    });
    return { key: input.key, byteSize: body.byteLength, contentType, checksumSha256 };
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const obj = this.objects.get(key);
    if (!obj) throw new Error(`object not found: fingerprint=${fingerprint(key)}`);
    return {
      key,
      byteSize: obj.body.byteLength,
      contentType: obj.contentType,
      checksumSha256: obj.checksumSha256,
    };
  }

  async getSignedUrl(key: string, options: SignedUrlOptions): Promise<SignedUrl> {
    assertShortExpiry(options.expiresInSeconds);
    if (!this.objects.has(key))
      throw new Error(`object not found: fingerprint=${fingerprint(key)}`);
    const expiresAtEpochMs = this.clock() + options.expiresInSeconds * 1000;
    const token = randomUUID();
    const signature = createHmac('sha256', this.signingSecret)
      .update(`${token}|${key}|${expiresAtEpochMs}`)
      .digest('hex');
    const url = `mem://signed/${token}/${encodeURIComponent(key)}?exp=${expiresAtEpochMs}&sig=${signature}`;
    this.signed.set(token, {
      key,
      expiresAtEpochMs,
      responseContentDisposition: options.responseContentDisposition,
    });
    return { url, expiresAtEpochMs };
  }

  /** Test/smoke helper: resolve a previously-issued signed URL to bytes. */
  resolveSignedUrl(
    url: string,
  ): { key: string; body: Buffer; responseContentDisposition?: string } | null {
    if (!url.startsWith('mem://signed/')) return null;
    const rest = url.slice('mem://signed/'.length);
    const [token] = rest.split('/');
    if (!token) return null;
    const pending = this.signed.get(token);
    if (!pending || this.clock() > pending.expiresAtEpochMs) return null;
    const obj = this.objects.get(pending.key);
    if (!obj) return null;
    const result: { key: string; body: Buffer; responseContentDisposition?: string } = {
      key: pending.key,
      body: obj.body,
    };
    if (pending.responseContentDisposition !== undefined) {
      result.responseContentDisposition = pending.responseContentDisposition;
    }
    return result;
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
    for (const [token, pending] of this.signed) {
      if (pending.key === key) this.signed.delete(token);
    }
  }
}

export function assertShortExpiry(expiresInSeconds: number): void {
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new Error('expiresInSeconds must be a positive integer');
  }
  if (expiresInSeconds > 900) throw new Error('expiresInSeconds exceeds 900s hard ceiling');
}

function toBuffer(body: PutObjectInput['body']): Buffer {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(body);
}

function sha256Hex(buf: Buffer): string {
  // ponytail: lazy — single-buffer hashing is enough for B0-07 spike artifacts.
  // upgrade when object bodies are streamed or exceed current artifact limits.
  return createHash('sha256').update(buf).digest('hex');
}
