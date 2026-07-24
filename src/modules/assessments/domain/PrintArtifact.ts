/**
 * B5-02 — PrintArtifact domain types.
 *
 * Artifact lifecycle:
 *   pending → rendering → ready | failed
 *
 * Deterministic reuse: artifact is keyed by contentHash (sha256 of the HTML body).
 * Same hash → same artifact key → no re-render.
 *
 * Tenant isolation: every artifact is scoped to workspaceId + assessmentId.
 */

export type ArtifactStatus = 'pending' | 'rendering' | 'ready' | 'failed';

export interface PrintArtifact {
  id: string;
  workspaceId: string;
  assessmentId: string;
  /** sha256 of the HTML content — used for deterministic reuse */
  contentHash: string;
  /** Storage key for the artifact file */
  storageKey: string;
  /** MIME type of the artifact (text/html for stub, application/pdf for real) */
  contentType: string;
  status: ArtifactStatus;
  /** byte size of the stored artifact */
  byteSize: number;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---- Store contract ----

export interface PrintArtifactStore {
  /** Save or update an artifact record */
  save(artifact: PrintArtifact): Promise<PrintArtifact>;

  /** Find latest artifact for an assessment in a workspace */
  findByAssessment(workspaceId: string, assessmentId: string): Promise<PrintArtifact | null>;

  /** Find by content hash — used for deterministic reuse check */
  findByContentHash(workspaceId: string, contentHash: string): Promise<PrintArtifact | null>;

  /** Find by storage key (for deletion) */
  findByStorageKey(storageKey: string): Promise<PrintArtifact | null>;

  /** Hard-delete artifact record (called when assessment is deleted) */
  delete(id: string): Promise<void>;

  /** List all artifacts for a workspace (for retention policy) */
  listByWorkspace(workspaceId: string): Promise<PrintArtifact[]>;
}
