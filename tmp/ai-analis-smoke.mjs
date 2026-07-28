import { readFileSync } from 'node:fs';
import { ProductAiService } from '../dist/infrastructure/ai/application/ProductAiService.js';
import { HermesAdapter } from '../dist/infrastructure/ai/adapters/hermes/HermesAdapter.js';
import { AiAuditRepository } from '../dist/infrastructure/ai/persistence/AiAuditRepository.js';
import { createDatabase } from '../dist/infrastructure/database/db.js';
import { parseAiEnv } from '../dist/config/ai.env.js';
import { QUESTION_OUTPUT_SCHEMA } from '../dist/modules/assessments/application/QuestionGenerationService.js';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !line.trim().startsWith('#') && line.includes('='))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);

const aiEnv = parseAiEnv(env);
const db = createDatabase({ connectionString: env.DATABASE_URL });
const adapter = new HermesAdapter({
  primary: {
    apiKey: env.HERMES_API_KEY,
    baseUrl: env.HERMES_BASE_URL,
    modelId: env.AI_MODEL_ID,
    timeoutMs: 60000,
  },
  fallbacks: [],
  live: true,
});
const service = new ProductAiService({
  adapter,
  env: aiEnv,
  schemas: new Map([['question-generation-v1', QUESTION_OUTPUT_SCHEMA]]),
  audit: new AiAuditRepository(db),
});

const res = await service.run({
  workspaceId: '11111111-1111-1111-1111-111111111111',
  actorId: 'system',
  promptTemplateId: 'question-generation-v1',
  schemaVersion: 1,
  prompt: 'Buat 1 soal pilihan ganda bahasa Indonesia level mudah tentang ide pokok paragraf. Output wajib sesuai schema. Jangan sertakan markdown.',
  schema: QUESTION_OUTPUT_SCHEMA,
  tokenEstimateHint: null,
  signals: { questionType: 'multiple_choice', difficulty: 'easy', sequence: 0 },
  jobId: '44444444-4444-4444-8444-444444444444',
});

console.log(JSON.stringify(res));
