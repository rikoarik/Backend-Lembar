import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { fingerprint } from '../../common/redact.js';
import { assertShortExpiry } from './InMemoryAdapter.js';
import type {
  HeadObjectResult,
  PutObjectInput,
  PutObjectResult,
  SignedUrl,
  SignedUrlOptions,
  StorageAdapter,
} from './StorageAdapter.js';

interface LocalManifest {
  contentType: string;
  cacheControlSeconds: number | undefined;
  checksumSha256: string;
}

/**
 * Local filesystem adapter. Persists objects under a root directory and issues
 * in-process signed URL paths. The path is a secret and MUST NOT be logged.
 */
export class LocalFilesystemAdapter implements StorageAdapter {
  private readonly signingSecret: string;
  private readonly clock: () => number;

  constructor(
    private readonly rootDir: string,
    opts: { signingSecret?: string; clock?: () => number } = {},
  ) {
    if (!rootDir) throw new Error('LocalFilesystemAdapter: rootDir required');
    this.signingSecret = opts.signingSecret ?? randomUUID();
    this.clock = opts.clock ?? (() => Date.now());
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const body = toBuffer(input.body);
    const contentType = input.contentType ?? 'application/octet-stream';
    const checksumSha256 = sha256Hex(body);
    await this.ensureParent(input.key);
    await writeFile(this.objectPath(input.key), body);
    await writeFile(
      this.manifestPath(input.key),
      JSON.stringify({
        contentType,
        cacheControlSeconds: input.cacheControlSeconds,
        checksumSha256,
      }),
      'utf8',
    );
    return { key: input.key, byteSize: body.byteLength, contentType, checksumSha256 };
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const manifest = await this.readManifest(key);
    const body = await readFile(this.objectPath(key));
    return {
      key,
      byteSize: body.byteLength,
      contentType: manifest.contentType,
      checksumSha256: manifest.checksumSha256,
    };
  }

  async getSignedUrl(key: string, options: SignedUrlOptions): Promise<SignedUrl> {
    assertShortExpiry(options.expiresInSeconds);
    await this.headObject(key);
    const expiresAtEpochMs = this.clock() + options.expiresInSeconds * 1000;
    const token = randomUUID();
    const signature = createHmac('sha256', this.signingSecret)
      .update(`${token}|${key}|${expiresAtEpochMs}`)
      .digest('hex');
    const disp = options.responseContentDisposition
      ? `&disp=${encodeURIComponent(options.responseContentDisposition)}`
      : '';
    return {
      url: `/storage/local/${token}/${encodeURIComponent(key)}?exp=${expiresAtEpochMs}&sig=${signature}${disp}`,
      expiresAtEpochMs,
    };
  }

  /** Test/smoke helper: validate a signed URL and return bytes. */
  async resolveSignedUrl(url: string): Promise<{ body: Buffer; manifest: LocalManifest } | null> {
    if (!url.startsWith('/storage/local/')) return null;
    const rest = url.slice('/storage/local/'.length);
    const [pathPart = '', qs = ''] = rest.split('?');
    const params = new URLSearchParams(qs);
    const expRaw = params.get('exp');
    const sig = params.get('sig');
    const token = pathPart.split('/')[0];
    const key = decodeURIComponent(pathPart.split('/').slice(1).join('/'));
    if (!token || !key || !expRaw || !sig) return null;
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || this.clock() > exp) return null;
    const expected = createHmac('sha256', this.signingSecret)
      .update(`${token}|${key}|${exp}`)
      .digest('hex');
    if (expected !== sig) return null;
    const body = await readFile(this.objectPath(key));
    const manifest = await this.readManifest(key);
    return { body, manifest };
  }

  async deleteObject(key: string): Promise<void> {
    await unlinkIfExists(this.objectPath(key));
    await unlinkIfExists(this.manifestPath(key));
  }

  private objectPath(key: string): string {
    return path.join(this.rootDir, key);
  }

  private manifestPath(key: string): string {
    return `${this.objectPath(key)}.manifest.json`;
  }

  private async ensureParent(key: string): Promise<void> {
    await mkdir(path.dirname(this.objectPath(key)), { recursive: true });
  }

  private async readManifest(key: string): Promise<LocalManifest> {
    try {
      return JSON.parse(await readFile(this.manifestPath(key), 'utf8')) as LocalManifest;
    } catch {
      throw new Error(`object not found: fingerprint=${fingerprint(key)}`);
    }
  }
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Already absent is fine for idempotent cleanup.
  }
}

function toBuffer(body: PutObjectInput['body']): Buffer {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(body);
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
