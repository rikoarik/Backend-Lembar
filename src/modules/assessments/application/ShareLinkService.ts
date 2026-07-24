/**
 * B5-03 — ShareLinkService.
 *
 * Responsibilities:
 * - Create high-entropy share links (32 bytes random, hex-encoded = 64 chars)
 * - Validate token: check existence, expiry, revocation
 * - Revoke share link (soft-delete: set revokedAt)
 * - Tenant isolation: only owning workspace can create/revoke
 *
 * Invariants:
 * - token >= 64 hex chars (32 bytes entropy)
 * - expired link → ApiError AUTH_REQUIRED (401)
 * - revoked link → ApiError AUTH_REQUIRED (401)
 * - wrong workspace on revoke → ApiError PERMISSION_DENIED (403)
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { ApiError } from '../../../common/errors/envelope.js';
import type { ShareLink, ShareLinkStore } from '../domain/ShareLink.js';

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface CreateShareLinkInput {
  workspaceId: string;
  assessmentId: string;
  /** TTL in seconds. Defaults to 7 days. */
  ttlSeconds?: number;
  requestId: string;
}

export interface ShareLinkServiceOptions {
  store: ShareLinkStore;
  clock?: () => Date;
  id?: () => string;
  token?: () => string;
}

export class ShareLinkService {
  private readonly clock: () => Date;
  private readonly id: () => string;
  private readonly generateToken: () => string;

  constructor(private readonly options: ShareLinkServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.generateToken = options.token ?? (() => randomBytes(32).toString('hex'));
  }

  /** Create a new share link. Token is 32 bytes of CSPRNG, hex-encoded (64 chars). */
  async createShareLink(input: CreateShareLinkInput): Promise<ShareLink> {
    const now = this.clock();
    const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();

    const link: ShareLink = {
      id: this.id(),
      workspaceId: input.workspaceId,
      assessmentId: input.assessmentId,
      token: this.generateToken(),
      expiresAt,
      revokedAt: null,
      createdAt: now.toISOString(),
    };

    return this.options.store.save(link);
  }

  /**
   * Validate token for public access.
   *
   * @throws ApiError AUTH_REQUIRED (401) if token not found, expired, or revoked
   */
  async validateToken(token: string, requestId: string): Promise<ShareLink> {
    const link = await this.options.store.findByToken(token);

    if (!link) {
      throw new ApiError({ code: 'AUTH_REQUIRED', message: 'Share link not found or invalid.', requestId });
    }

    if (link.revokedAt !== null) {
      throw new ApiError({ code: 'AUTH_REQUIRED', message: 'Share link has been revoked.', requestId });
    }

    const now = this.clock();
    if (new Date(link.expiresAt) < now) {
      throw new ApiError({ code: 'AUTH_REQUIRED', message: 'Share link has expired.', requestId });
    }

    return link;
  }

  /**
   * Revoke a share link. Only the owning workspace can revoke.
   *
   * @throws ApiError RESOURCE_NOT_FOUND (404) if token not found
   * @throws ApiError PERMISSION_DENIED (403) if wrong workspace
   */
  async revokeShareLink(token: string, requestingWorkspaceId: string, requestId: string): Promise<ShareLink> {
    const link = await this.options.store.findByToken(token);

    if (!link) {
      throw new ApiError({ code: 'RESOURCE_NOT_FOUND', message: 'Share link not found.', requestId });
    }

    if (link.workspaceId !== requestingWorkspaceId) {
      throw new ApiError({ code: 'PERMISSION_DENIED', message: 'You do not own this share link.', requestId });
    }

    const revoked = await this.options.store.revoke(token);
    if (!revoked) {
      throw new ApiError({ code: 'RESOURCE_NOT_FOUND', message: 'Share link could not be revoked.', requestId });
    }

    return revoked;
  }

  /** List all share links for an assessment (tenant-scoped). */
  async listByAssessment(workspaceId: string, assessmentId: string): Promise<ShareLink[]> {
    return this.options.store.findByAssessment(workspaceId, assessmentId);
  }
}
