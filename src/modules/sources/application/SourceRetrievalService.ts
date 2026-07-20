/**
 * B3-01 — Tenant-scoped source retrieval and citation resolution service.
 *
 * Responsibilities:
 * 1. Retrieve passages for a set of source uploads, scoped to a single workspace.
 * 2. Fail fast with InsufficientSourceError when no usable passages exist.
 * 3. Resolve citation IDs back to authorized passages (cross-tenant safe).
 * 4. Sanitize untrusted source text before it enters prompt paths.
 *
 * Tenant isolation: every store call includes workspaceId. Cross-workspace
 * reads return empty, never leak content.
 *
 * Prompt-injection hardening: retrieved passage text is sanitized to remove
 * control characters, excessive whitespace, and known injection patterns before
 * being returned to callers who will embed it in AI prompts.
 */
import type {
  ResolveCitationsInput,
  ResolveCitationsResult,
  ResolvedCitation,
  RetrievedPassage,
  RetrievePassagesInput,
  RetrievePassagesResult,
  SourceRetrievalStore,
} from '../domain/SourceRetrieval.js';
import { InsufficientSourceError } from '../domain/SourceRetrieval.js';

// ---- Prompt-injection hardening ----

/**
 * Sanitize untrusted source text before it enters a privileged prompt path.
 *
 * Threats addressed:
 * - Control characters (U+0000-U+001F except newline/tab, U+007F, U+200B-ZWSP,
 *   U+FEFF-BOM) that could confuse tokenizers or hide injection payloads.
 * - Excessive whitespace / newlines that could push system instructions out of
 *   the context window.
 * - Known injection patterns like "Ignore previous instructions", "SYSTEM:",
 *   "ASSISTANT:", "Human:" role-play headers that try to hijack the prompt.
 * - HTML/script tags that could cause rendering issues downstream.
 *
 * This is defense-in-depth, not a complete solution. The caller should still
 * wrap source text in delimiters (e.g., <source>...</source>) in the prompt.
 */
export function sanitizeSourceText(raw: string): string {
  if (!raw) return '';

  let text = raw;

  // Strip control characters (keep \n \t \r)
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Strip zero-width characters that can hide payloads
  // eslint-disable-next-line no-misleading-character-class
  text = text.replace(/[\u200B\u200C\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');

  // Strip HTML tags (source text should be plain)
  text = text.replace(/<[^>]*>/g, '');

  // Collapse excessive whitespace (3+ consecutive spaces → 2)
  text = text.replace(/ {3,}/g, '  ');

  // Collapse excessive newlines (3+ → 2)
  text = text.replace(/\n{3,}/g, '\n\n');

  // Neutralize common prompt-injection patterns (case-insensitive)
  // Replace with [REDACTED] so the injection attempt is visible in review but inert.
  const injectionPatterns = [
    /\bignore\s+(all\s+)?(previous|prior|above)\s+instructions?\b/gi,
    /\bignore\s+everything\s+(above|before|prior)\b/gi,
    /\byou\s+are\s+now\s+(a|an)\b/gi,
    /\bsystem\s*:\s*/gi,
    /\bassistant\s*:\s*/gi,
    /\bhuman\s*:\s*/gi,
    /\buser\s*:\s*/gi,
    /\bnew\s+instructions?\s*:/gi,
    /\boverride\s+(all\s+)?(safety|rules|instructions)\b/gi,
    /\bforget\s+(all\s+)?(previous|prior|above)\b/gi,
    /\bdisregard\s+(all\s+)?(previous|prior|above)\b/gi,
    /\bact\s+as\s+(if|though)\b/gi,
    /\bpretend\s+you\s+are\b/gi,
    /\byour\s+(new|updated)\s+instructions?\s+(are|is)\b/gi,
  ];

  for (const pattern of injectionPatterns) {
    text = text.replace(pattern, '[REDACTED]');
  }

  return text.trim();
}

// ---- Service ----

export interface SourceRetrievalServiceOptions {
  retrievalStore: SourceRetrievalStore;
  sanitize?: (text: string) => string;
}

export class SourceRetrievalService {
  private readonly store: SourceRetrievalStore;
  private readonly sanitize: (text: string) => string;

  constructor(options: SourceRetrievalServiceOptions) {
    this.store = options.retrievalStore;
    this.sanitize = options.sanitize ?? sanitizeSourceText;
  }

  /**
   * Retrieve passages for the given source uploads.
   *
   * Throws InsufficientSourceError (terminal) when:
   * - No upload IDs provided
   * - All upload IDs are not found in this workspace
   * - All uploads found have zero extracted passages
   *
   * Returns partial results when some (but not all) uploads have passages.
   * The caller can inspect emptyUploadIds and missingUploadIds to decide
   * whether to retry or report partial failure.
   */
  async retrieve(input: RetrievePassagesInput): Promise<RetrievePassagesResult> {
    const { workspaceId, sourceUploadIds, limitPerUpload } = input;

    // Terminal: no uploads provided
    if (!sourceUploadIds || sourceUploadIds.length === 0) {
      throw new InsufficientSourceError('no_uploads_provided', workspaceId, []);
    }

    // Deduplicate
    const uniqueIds = [...new Set(sourceUploadIds)];

    // Check which uploads are ready (verified) in this workspace
    const readyIds = await this.store.getReadyUploadIds(workspaceId, uniqueIds);
    const missingUploadIds = uniqueIds.filter((id) => !readyIds.includes(id));

    // Terminal: none of the uploads exist in this workspace
    if (readyIds.length === 0) {
      throw new InsufficientSourceError('uploads_not_found', workspaceId, uniqueIds);
    }

    // Retrieve passages for ready uploads
    const passagesByUpload = await this.store.listPassagesForUploads(workspaceId, readyIds, {
      ...(limitPerUpload !== undefined ? { limitPerUpload } : {}),
    });

    const allPassages: RetrievedPassage[] = [];
    const emptyUploadIds: string[] = [];

    for (const uploadId of readyIds) {
      const passages = passagesByUpload.get(uploadId) ?? [];
      if (passages.length === 0) {
        emptyUploadIds.push(uploadId);
      } else {
        // Sanitize passage text before returning
        for (const passage of passages) {
          allPassages.push({
            ...passage,
            text: this.sanitize(passage.text),
          });
        }
      }
    }

    // Terminal: all ready uploads have zero passages (extraction not done or failed)
    if (allPassages.length === 0) {
      throw new InsufficientSourceError('no_passages_extracted', workspaceId, readyIds);
    }

    return {
      passages: allPassages,
      emptyUploadIds,
      missingUploadIds,
    };
  }

  /**
   * Resolve citation IDs back to authorized passages.
   *
   * Each citationId is treated as a passageId. Resolution is workspace-scoped:
   * passages belonging to other workspaces are silently unresolved (no leak).
   *
   * The returned passage text is already sanitized.
   */
  async resolveCitations(input: ResolveCitationsInput): Promise<ResolveCitationsResult> {
    const { workspaceId, citationIds } = input;

    if (!citationIds || citationIds.length === 0) {
      return { resolved: [], unresolvedIds: [] };
    }

    const uniqueIds = [...new Set(citationIds)];
    const resolved: ResolvedCitation[] = [];
    const unresolvedIds: string[] = [];

    for (const citationId of uniqueIds) {
      const passage = await this.store.getPassageById(workspaceId, citationId);
      if (passage) {
        resolved.push({
          citationId,
          passageId: passage.passageId,
          uploadId: passage.uploadId,
          pageNumber: passage.pageNumber,
          sequence: passage.sequence,
          text: this.sanitize(passage.text),
        });
      } else {
        unresolvedIds.push(citationId);
      }
    }

    return { resolved, unresolvedIds };
  }
}

// ---- Factory ----

export function createSourceRetrievalService(options: {
  retrievalStore: SourceRetrievalStore;
  sanitize?: (text: string) => string;
}): SourceRetrievalService {
  return new SourceRetrievalService(options);
}
