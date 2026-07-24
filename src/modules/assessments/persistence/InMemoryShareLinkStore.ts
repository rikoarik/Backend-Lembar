/**
 * B5-03 — In-memory implementation of ShareLinkStore.
 *
 * Used in tests and development. Thread-safe for single-process use.
 */
import type { ShareLink, ShareLinkStore } from '../domain/ShareLink.js';

export class InMemoryShareLinkStore implements ShareLinkStore {
  private readonly byId = new Map<string, ShareLink>();
  private readonly byToken = new Map<string, ShareLink>();

  async save(link: ShareLink): Promise<ShareLink> {
    this.byId.set(link.id, link);
    this.byToken.set(link.token, link);
    return link;
  }

  async findByToken(token: string): Promise<ShareLink | null> {
    return this.byToken.get(token) ?? null;
  }

  async findByAssessment(workspaceId: string, assessmentId: string): Promise<ShareLink[]> {
    return [...this.byId.values()].filter(
      (l) => l.workspaceId === workspaceId && l.assessmentId === assessmentId,
    );
  }

  async revoke(token: string): Promise<ShareLink | null> {
    const link = this.byToken.get(token);
    if (!link) return null;
    const revoked: ShareLink = { ...link, revokedAt: new Date().toISOString() };
    this.byId.set(revoked.id, revoked);
    this.byToken.set(revoked.token, revoked);
    return revoked;
  }

  async delete(id: string): Promise<void> {
    const link = this.byId.get(id);
    if (link) {
      this.byToken.delete(link.token);
      this.byId.delete(id);
    }
  }

  /** Test helper: clear all data. */
  clear(): void {
    this.byId.clear();
    this.byToken.clear();
  }
}
