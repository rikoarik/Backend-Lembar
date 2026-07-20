/**
 * B3-01 — Domain types for tenant-scoped source retrieval and citation resolution.
 *
 * Retrieval is the read-side complement to B2-02 extraction: given a set of
 * sourceUploadIds, fetch their authorized passages scoped to a single workspace.
 *
 * Citation resolution maps opaque citation references (passageId) back to the
 * passage text, but only if the passage belongs to the requesting workspace.
 *
 * Tenant isolation: every operation requires workspaceId. Cross-workspace reads
 * return empty / not-found, never leak content.
 */

// ---- Retrieval ----

export interface RetrievePassagesInput {
  workspaceId: string;
  sourceUploadIds: string[];
  /** Maximum passages to return per upload. Default: all. */
  limitPerUpload?: number;
}

export interface RetrievedPassage {
  passageId: string;
  uploadId: string;
  pageNumber: number;
  sequence: number;
  text: string;
  charCount: number;
  contentHash: string;
}

export interface RetrievePassagesResult {
  passages: RetrievedPassage[];
  /** Upload IDs that had zero passages (not found, deleted, or not yet extracted). */
  emptyUploadIds: string[];
  /** Upload IDs that were not found at all in this workspace. */
  missingUploadIds: string[];
}

// ---- Citation resolution ----

export interface ResolveCitationsInput {
  workspaceId: string;
  citationIds: string[];
}

export interface ResolvedCitation {
  citationId: string;
  passageId: string;
  uploadId: string;
  pageNumber: number;
  sequence: number;
  /** The original passage text (already sanitized on retrieval). */
  text: string;
}

export interface ResolveCitationsResult {
  resolved: ResolvedCitation[];
  /** Citation IDs that could not be resolved (not found or cross-tenant). */
  unresolvedIds: string[];
}

// ---- Insufficient source ----

export type InsufficientSourceReason =
  | 'no_uploads_provided'
  | 'no_passages_extracted'
  | 'uploads_not_found'
  | 'uploads_not_ready';

export class InsufficientSourceError extends Error {
  readonly reason: InsufficientSourceReason;
  readonly workspaceId: string;
  readonly uploadIds: string[];

  constructor(
    reason: InsufficientSourceReason,
    workspaceId: string,
    uploadIds: string[],
    message?: string,
  ) {
    super(message ?? `Insufficient source: ${reason}`);
    this.name = 'InsufficientSourceError';
    this.reason = reason;
    this.workspaceId = workspaceId;
    this.uploadIds = uploadIds;
  }
}

// ---- Store contract for retrieval ----

export interface SourceRetrievalStore {
  /**
   * List passages for a single upload, scoped to workspace.
   * Returns empty array if upload not found in this workspace.
   */
  listPassagesForUpload(
    workspaceId: string,
    uploadId: string,
    options?: { limit?: number },
  ): Promise<RetrievedPassage[]>;

  /**
   * List passages for multiple uploads, scoped to workspace.
   * Returns a map of uploadId -> passages. Missing uploads get empty arrays.
   */
  listPassagesForUploads(
    workspaceId: string,
    uploadIds: string[],
    options?: { limitPerUpload?: number },
  ): Promise<Map<string, RetrievedPassage[]>>;

  /**
   * Resolve a single passage by ID, scoped to workspace.
   * Returns null if not found or belongs to a different workspace.
   */
  getPassageById(workspaceId: string, passageId: string): Promise<RetrievedPassage | null>;

  /**
   * Check which upload IDs exist and are in 'verified' status for this workspace.
   * Returns the subset that are ready for retrieval.
   */
  getReadyUploadIds(workspaceId: string, uploadIds: string[]): Promise<string[]>;
}
