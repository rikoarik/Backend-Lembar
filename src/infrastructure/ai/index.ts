/** B0-08 — product-runtime AI provider adapter spike public surface. */
export {
  AI_DRIVERS,
  AI_PROVIDER_OUTCOMES,
  parseAiEnv,
  type AiDriver,
  type AiProviderOutcome,
} from '../../config/ai.env.js';
export { ProductAiService } from './application/ProductAiService.js';
export type {
  ProductAiRequest,
  ProductAiResult,
  ProductAiServiceDeps,
} from './application/ProductAiService.js';
export type {
  AiGenerateInput,
  AiGenerateOutcome,
  AiGenerateResult,
  AiAdapterMeta,
  ProductAiAdapter,
} from './domain/ProductAiAdapter.js';
export { JsonSchemaValidator } from './domain/JsonSchemaValidator.js';
export { AiAdapterError, fingerprintString } from './domain/errors.js';
export {
  MockAiAdapter,
  mockDriverSwitches,
  registerMockFixture,
} from './adapters/mock/MockAiAdapter.js';
export {
  OpenAiAdapter,
  type OpenAiAdapterConfig,
  type OpenAiAdapterDeps,
} from './adapters/openai/OpenAiAdapter.js';
export {
  AiAuditRepository,
  InMemoryAiAuditRecorder,
  type AiAuditInput,
} from './persistence/AiAuditRepository.js';
export {
  aiJobsAudit,
  AI_DRIVERS as AI_PERSISTENCE_DRIVERS,
  AI_OUTCOMES,
  type AiDriver as AiPersistenceDriver,
  type AiOutcome,
  type AiJobsAuditRow,
} from './persistence/schema.js';
