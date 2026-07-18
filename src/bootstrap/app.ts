import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface BuildAppOptions {
  logger?: FastifyServerOptions['logger'];
  serviceName?: string;
  serviceVersion?: string;
}

const DEFAULT_SERVICE_NAME = 'lembar-api';
const DEFAULT_SERVICE_VERSION = '0.0.0-b001';

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: 'info',
            serializers: {
              req: () => ({ redacted: true }),
              res: (res) => ({ statusCode: res.statusCode }),
            },
          },
  });

  const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
  const serviceVersion = options.serviceVersion ?? DEFAULT_SERVICE_VERSION;
  const startedAt = Date.now();

  app.get('/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      service: serviceName,
      version: serviceVersion,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  });

  return app;
}
