import { InMemoryAdapter } from './InMemoryAdapter.js';
import { LocalFilesystemAdapter } from './LocalFilesystemAdapter.js';
import type { StorageAdapter } from './StorageAdapter.js';

export type StorageDriver = 'local' | 'memory';

export interface CreateStorageAdapterOptions {
  driver?: StorageDriver;
  rootDir?: string;
  signingSecret?: string;
}

export function resolveStorageDriver(env: NodeJS.ProcessEnv = process.env): StorageDriver {
  const raw = (env['STORAGE_DRIVER'] ?? 'memory').toLowerCase();
  if (raw === 'local' || raw === 'memory') return raw;
  throw new Error(`Unsupported STORAGE_DRIVER: ${raw}`);
}

/** Build a StorageAdapter from STORAGE_DRIVER. Defaults to memory. */
export function createStorageAdapter(
  options: CreateStorageAdapterOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): StorageAdapter {
  const driver = options.driver ?? resolveStorageDriver(env);
  const adapterOptions = options.signingSecret ? { signingSecret: options.signingSecret } : {};
  switch (driver) {
    case 'memory':
      return new InMemoryAdapter(adapterOptions);
    case 'local': {
      const rootDir = options.rootDir ?? env['STORAGE_LOCAL_ROOT'];
      if (!rootDir) throw new Error('STORAGE_LOCAL_ROOT required for STORAGE_DRIVER=local');
      return new LocalFilesystemAdapter(rootDir, adapterOptions);
    }
  }
}
