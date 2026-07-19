/**
 * B2-01 — Application-layer factory for uploads service composition.
 *
 * This is the only public entry point for wiring the uploads domain service
 * with its persistence and storage adapters. It chooses the store implementation
 * based on whether a Database is provided (Postgres) or not (InMemory).
 */
import type { Database } from '../../../infrastructure/database/db.js';
import type { StorageAdapter } from '../../../infrastructure/storage/StorageAdapter.js';
import {
  createStorageAdapter,
  resolveStorageDriver,
} from '../../../infrastructure/storage/createStorageAdapter.js';
import { createPostgresSourceUploadsService } from '../domain/SourceUploadsService.js';
import { createInMemorySourceUploadsService } from '../domain/SourceUploadsService.js';
import type { SourceUploadsService } from '../domain/SourceUploadsService.js';

export interface CreateUploadsServiceOptions {
  db?: Database;
  storage?: StorageAdapter;
  /** Storage driver label persisted on `source_upload_versions.storage_driver`. */
  storageDriverName?: string;
  /** Hard ceiling for upload size; defaults to env SOURCE_UPLOAD_MAX_BYTES or 50 MiB. */
  maxBytes?: number;
}

export function createUploadsService(
  options: CreateUploadsServiceOptions = {},
): SourceUploadsService {
  const storage = options.storage ?? createStorageAdapter();
  const driverName = options.storageDriverName ?? resolveStorageDriver();

  if (options.db) {
    return createPostgresSourceUploadsService({
      db: options.db,
      storage,
      storageDriverName: driverName,
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    });
  }

  return createInMemorySourceUploadsService({
    storage,
    storageDriverName: driverName,
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
  });
}
