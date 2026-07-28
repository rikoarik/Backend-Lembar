import { readFileSync } from 'node:fs';
import { HermesAdapter } from '../dist/infrastructure/ai/adapters/hermes/HermesAdapter.js';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
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
const result = await adapter.generate({
  workspaceId: 'probe',
  promptTemplateId: 'question-generation-v1',
  schemaVersion: 1,
  prompt: 'Buat 1 soal pilihan ganda bahasa Indonesia level mudah tentang ide pokok paragraf. Output wajib JSON tanpa markdown.',
  contextWindowId: null,
  tokenEstimateHint: null,
  signals: {},
  attemptNumber: 1,
  maxSchemaRepairAttempts: 1,
});
if (!result.ok) throw new Error('invalid envelope');
const outcome = result.value;
if (outcome.kind !== 'succeeded' && outcome.kind !== 'schema_invalid') {
  console.log(JSON.stringify({ kind: outcome.kind }));
} else {
  const text = outcome.responseText;
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  console.log(JSON.stringify({ kind: outcome.kind, parsed }, null, 2));
}
