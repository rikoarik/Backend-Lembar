/**
 * B5-03 — ShareLink domain types.
 *
 * High-entropy scoped share links with TTL and revocation.
 *
 * Key invariants:
 * - token is 32+ bytes of cryptographically secure random data (hex-encoded = 64+ chars)
 * - Every share link is scoped to a workspaceId + assessmentId
 * - expiresAt enforced at validation time (expired → 401)
 * - revokedAt set on revoke (revoked → 401)
 * - Tenant isolation: only the owning workspace can create/revoke
 */

export type ShareLinkStatus = 'active' | 'expired' | 'revoked';

export interface ShareLink {
  id: string;
  /** Scoped to the workspace that created this link */
  workspaceId: string;
  /** The assessment this link grants access to */
  assessmentId: string;
  /** High-entropy token: 32 bytes random, hex-encoded (64 chars) */
  token: string;
  /** ISO-8601 when this link expires */
  expiresAt: string;
  /** ISO-8601 when this link was revoked, null if still active */
  revokedAt: string | null;
  createdAt: string;
}

// ---- Store contract ----

export interface ShareLinkStore {
  save(link: ShareLink): Promise<ShareLink>;
  findByToken(token: string): Promise<ShareLink | null>;
  findByAssessment(workspaceId: string, assessmentId: string): Promise<ShareLink[]>;
  /** Soft-revoke: set revokedAt on existing link */
  revoke(token: string): Promise<ShareLink | null>;
  /** Hard-delete (for retention/test teardown) */
  delete(id: string): Promise<void>;
}
