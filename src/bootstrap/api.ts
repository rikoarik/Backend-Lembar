import { type FastifyInstance } from 'fastify';

import { parseApiEnv, type ApiEnv } from '../config/api.env.js';
import { ConfigError, formatConfigError } from '../config/errors.js';
import { buildApp } from './app.js';

export interface ApiRuntimeOptions {
  port: number;
  host: string;
  logger: boolean;
  serviceName?: string;
  serviceVersion?: string;
}

export function resolveApiOptions(env: NodeJS.ProcessEnv = process.env): ApiRuntimeOptions {
  let cfg: ApiEnv;
  try {
    cfg = parseApiEnv(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new Error(`Invalid API configuration: ${formatConfigError(err.issues)}`, {
        cause: err,
      });
    }
    throw err;
  }
  return {
    port: cfg.port,
    host: cfg.host,
    logger: cfg.logLevel !== 'silent',
    serviceName: cfg.serviceName,
    serviceVersion: cfg.serviceVersion,
  };
}

export async function startApi(options: ApiRuntimeOptions): Promise<FastifyInstance> {
  const buildOpts: Parameters<typeof buildApp>[0] = { logger: options.logger };
  if (options.serviceName !== undefined) buildOpts.serviceName = options.serviceName;
  if (options.serviceVersion !== undefined) buildOpts.serviceVersion = options.serviceVersion;
  const app = await buildApp(buildOpts);
  await app.listen({ port: options.port, host: options.host });
  return app;
}

// Boot when run directly (not when imported by tests).
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('bootstrap/api.js') === true;

if (isDirectRun) {
  const opts = resolveApiOptions();
  const app = await startApi(opts);
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'api shutdown requested');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
