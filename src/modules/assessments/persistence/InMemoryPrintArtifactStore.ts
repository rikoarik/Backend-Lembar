/**
 * B5-02 — In-memory PrintArtifactStore for tests.
 */
import { randomUUID } from 'node:crypto';

import type { PrintArtifact, PrintArtifactStore } from '../domain/PrintArtifact.js';

void randomUUID;

export class InMemoryPrintArtifactStore implements PrintArtifactStore {
  private readonly artifacts = new Map<string, PrintArtifact>();

  async save(artifact: PrintArtifact): Promise<PrintArtifact> {
    const copy = { ...artifact };
    this.artifacts.set(artifact.id, copy);
    return { ...copy };
  }

  async findByAssessment(workspaceId: string, assessmentId: string): Promise<PrintArtifact | null> {
    for (const a of this.artifacts.values()) {
      if (a.workspaceId === workspaceId && a.assessmentId === assessmentId) {
        return { ...a };
      }
    }
    return null;
  }

  async findByContentHash(workspaceId: string, contentHash: string): Promise<PrintArtifact | null> {
    for (const a of this.artifacts.values()) {
      if (a.workspaceId === workspaceId && a.contentHash === contentHash) {
        return { ...a };
      }
    }
    return null;
  }

  async findByStorageKey(storageKey: string): Promise<PrintArtifact | null> {
    for (const a of this.artifacts.values()) {
      if (a.storageKey === storageKey) return { ...a };
    }
    return null;
  }

  async delete(id: string): Promise<void> {
    this.artifacts.delete(id);
  }

  async listByWorkspace(workspaceId: string): Promise<PrintArtifact[]> {
    return Array.from(this.artifacts.values())
      .filter((a) => a.workspaceId === workspaceId)
      .map((a) => ({ ...a }));
  }
}
