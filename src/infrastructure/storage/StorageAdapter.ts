/**
 * Storage adapter contract.
 *
 * The spike only implements LocalFilesystem + InMemory behind STORAGE_DRIVER.
 * The interface intentionally mirrors object-storage primitives so a future
 * S3-compatible adapter (D-006) can replace it without breaking call sites.
 */
export interface PutObjectInput {
  /** Opaque storage key; random in production, deterministic in tests. */
  key: string;
  body: Uint8Array | Buffer | string;
  /** MIME content type; safe to log. */
  contentType?: string;
  /** Server-side cache hint in seconds; safe to log. */
  cacheControlSeconds?: number;
}

export interface PutObjectResult {
  key: string;
  byteSize: number;
  contentType: string;
  /** sha256 of the body, hex-encoded. Safe to log at low-cardinality. */
  checksumSha256: string;
}

export interface HeadObjectResult {
  key: string;
  byteSize: number;
  contentType: string;
  /** sha256 of the body, hex-encoded. */
  checksumSha256: string;
}

export interface SignedUrlOptions {
  /** Lifetime in seconds. MUST be short (≤900 in production). */
  expiresInSeconds: number;
  /** Optional override of the file name presented in Content-Disposition. */
  responseContentDisposition?: string;
}

export interface SignedUrl {
  /** The signed URL itself. Treat as a secret — never log. */
  url: string;
  /** Absolute epoch ms when the URL stops working. */
  expiresAtEpochMs: number;
}

export interface StorageAdapter {
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  /** Returns an opaque head result. Adapters may throw if the key is unknown. */
  headObject(key: string): Promise<HeadObjectResult>;
  /** Issue a short-lived download intent. Returns a SignedUrl with strict expiry. */
  getSignedUrl(key: string, options: SignedUrlOptions): Promise<SignedUrl>;
  deleteObject(key: string): Promise<void>;
}
