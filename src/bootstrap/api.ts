import { type FastifyInstance } from 'fastify';

import { buildApp } from './app.js';

export interface ApiRuntimeOptions {
  port: number;
  host: string;
  logger: boolean;
}

export function resolveApiOptions(env: NodeJS.ProcessEnv = process.env): ApiRuntimeOptions {
  const portRaw = env['API_PORT'] ?? '4000';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid API_PORT: ${portRaw}`);
  }
  const host = env['API_HOST'] ?? '127.0.0.1';
  const logger = (env['LOG_LEVEL'] ?? 'info') !== 'silent';
  return { port, host, logger };
}

export async function startApi(options: ApiRuntimeOptions): Promise<FastifyInstance> {
  const app = await buildApp({ logger: options.logger });
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
