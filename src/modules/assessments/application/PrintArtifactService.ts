/**
 * B5-02 — PrintArtifactService.
 *
 * Responsibilities:
 * - Trigger render (stub: write HTML as .html since playwright disabled)
 * - Store artifact privately via StorageAdapter
 * - Deterministic reuse: same contentHash → return existing artifact, no re-render
 * - Authorized download: return signed URL scoped to the workspace
 *
 * Tenant isolation: every public method requires workspaceId.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { StorageAdapter } from '../../../infrastructure/storage/StorageAdapter.js';
import type { PrintArtifact, PrintArtifactStore } from '../domain/PrintArtifact.js';
import type { PrintService } from './PrintService.js';
import { renderPrintHtml } from './printTemplate.js';
import { ApiError } from '../../../common/errors/envelope.js';

const SIGNED_URL_TTL_SECONDS = 300; // 5 minutes
const ARTIFACT_CONTENT_TYPE = 'text/html; charset=utf-8';

export interface PrintArtifactServiceOptions {
  artifactStore: PrintArtifactStore;
  storage: StorageAdapter;
  printService: PrintService;
  clock?: () => Date;
  id?: () => string;
}

export interface TriggerRenderResult {
  artifact: PrintArtifact;
  /** true if artifact already existed (deterministic reuse — no re-render) */
  reused: boolean;
}

export interface ArtifactInfoResult {
  artifact: PrintArtifact;
  /** Short-lived signed URL for authorized download */
  downloadUrl: string;
  expiresAtEpochMs: number;
}

export class PrintArtifactService {
  private readonly clock: () => Date;
  private readonly id: () => string;

  constructor(private readonly options: PrintArtifactServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  /**
   * Trigger render and store artifact. Idempotent via contentHash.
   *
   * Same HTML content → same contentHash → no re-render, returns existing artifact.
   *
   * @throws ApiError RESOURCE_NOT_FOUND (404) if assessment not found
   * @throws ApiError STATE_CONFLICT (409) if assessment is not finalized
   */
  async triggerRender(
    workspaceId: string,
    assessmentId: string,
    requestId: string,
  ): Promise<TriggerRenderResult> {
    // Build print document (validates assessment exists + is finalized)
    const doc = await this.options.printService.buildPrintDocument(workspaceId, assessmentId, requestId);

    // Render to HTML (stub — playwright disabled per B5-02 spec)
    const html = renderPrintHtml(doc);
    const htmlBuffer = Buffer.from(html, 'utf-8');
    const contentHash = createHash('sha256').update(htmlBuffer).digest('hex');

    // Deterministic reuse: if same hash already stored, return it
    const existing = await this.options.artifactStore.findByContentHash(workspaceId, contentHash);
    if (existing && existing.status === 'ready') {
      return { artifact: existing, reused: true };
    }

    // Generate deterministic storage key: artifacts/<workspaceId>/<assessmentId>/<hash>.html
    const storageKey = `artifacts/${workspaceId}/${assessmentId}/${contentHash}.html`;

    const now = this.clock().toISOString();
    const artifactId = this.id();

    // Store to filesystem
    const putResult = await this.options.storage.putObject({
      key: storageKey,
      body: htmlBuffer,
      contentType: ARTIFACT_CONTENT_TYPE,
    });

    // Save artifact record
    const artifact: PrintArtifact = {
      id: artifactId,
      workspaceId,
      assessmentId,
      contentHash,
      storageKey,
      contentType: ARTIFACT_CONTENT_TYPE,
      status: 'ready',
      byteSize: putResult.byteSize,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    };

    const saved = await this.options.artifactStore.save(artifact);
    return { artifact: saved, reused: false };
  }

  /**
   * Get artifact info and a signed download URL.
   *
   * @throws ApiError RESOURCE_NOT_FOUND (404) if no artifact for this assessment
   * @throws ApiError PERMISSION_DENIED (403) if artifact belongs to different workspace
   */
  async getArtifactInfo(
    workspaceId: string,
    assessmentId: string,
    requestId: string,
  ): Promise<ArtifactInfoResult> {
    const artifact = await this.options.artifactStore.findByAssessment(workspaceId, assessmentId);
    if (!artifact) {
      throw new ApiError({
        code: 'RESOURCE_NOT_FOUND',
        message: 'No artifact found for this assessment. Call POST /output first.',
        status: 404,
        requestId,
      });
    }

    // Enforce tenant isolation
    if (artifact.workspaceId !== workspaceId) {
      throw new ApiError({
        code: 'PERMISSION_DENIED',
        message: 'Access denied',
        status: 403,
        requestId,
      });
    }

    const signed = await this.options.storage.getSignedUrl(artifact.storageKey, {
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
      responseContentDisposition: `attachment; filename="${assessmentId}.html"`,
    });

    return {
      artifact,
      downloadUrl: signed.url,
      expiresAtEpochMs: signed.expiresAtEpochMs,
    };
  }

  /**
   * Delete artifact when assessment is deleted.
   * Best-effort: does not throw if artifact not found.
   */
  async deleteArtifactForAssessment(
    workspaceId: string,
    assessmentId: string,
  ): Promise<void> {
    const artifact = await this.options.artifactStore.findByAssessment(workspaceId, assessmentId);
    if (!artifact || artifact.workspaceId !== workspaceId) return;

    // Delete from storage (best-effort)
    try {
      await this.options.storage.deleteObject(artifact.storageKey);
    } catch {
      // storage delete failure — continue to delete record
    }

    await this.options.artifactStore.delete(artifact.id);
  }
}
