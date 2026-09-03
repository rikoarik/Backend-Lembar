import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { AiEnv } from '../../../../config/ai.env.js';
import type {
  QuestionImage,
  QuestionImageGenerationRequest,
  QuestionImageGenerator,
} from '../../../../modules/assessments/domain/QuestionGeneration.js';
import { runtimeConfig } from './HermesRuntimeAdapter.js';

const MAX_IMAGE_BYTES = 2_500_000;

/** Lembar → Hermes image_gen tool → xAI. Never calls the image provider itself. */
export class HermesQuestionImageGenerator implements QuestionImageGenerator {
  constructor(private readonly env: AiEnv) {}

  async generate(request: QuestionImageGenerationRequest): Promise<QuestionImage | null> {
    if (!this.env.imageEnabled || !this.env.imageApiKey) return null;
    const home = await mkdtemp(join(tmpdir(), 'lembar-hermes-image-'));
    try {
      await writeFile(join(home, 'config.yaml'), stringify(runtimeConfig(this.env)), { mode: 0o600 });
      const output = await runImageTool(home, imagePrompt(request), this.env.timeoutMs, this.env.imageApiKey, this.env.imageBaseUrl);
      const url = extractImageUrl(output);
      if (!url) return null;
      const response = await fetch(url, { signal: AbortSignal.timeout(this.env.timeoutMs) });
      if (!response.ok) return null;
      const contentType = response.headers.get('content-type')?.split(';')[0];
      if (contentType !== 'image/png' && contentType !== 'image/webp') return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
      return {
        dataUrl: `data:${contentType};base64,${bytes.toString('base64')}`,
        alt: request.alt.trim().slice(0, 300),
        mimeType: contentType,
        providerModelId: this.env.imageModelId,
      };
    } catch {
      return null;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}

function imagePrompt(request: QuestionImageGenerationRequest): string {
  const style = request.style === 'diagram' ? 'clean educational diagram' : 'age-appropriate educational illustration';
  return `Use image_generate once. Create a ${style}. ${request.prompt.trim().slice(0, 1500)} Do not reveal the answer. Return ONLY JSON: {"image":"public HTTPS URL"}.`;
}

function runImageTool(home: string, prompt: string, timeoutMs: number, apiKey: string, baseUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.env.HERMES_RUNTIME_BIN ?? 'hermes', ['--oneshot', prompt, '--ignore-rules', '--toolsets', 'image_gen'], {
      env: { ...process.env, HERMES_HOME: home, HERMES_ACCEPT_HOOKS: '1', XAI_API_KEY: apiKey, XAI_BASE_URL: baseUrl },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.on('close', () => { clearTimeout(timer); resolve(stdout); });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

function extractImageUrl(output: string): string | null {
  const match = output.match(/https:\/\/[^\s"}]+/);
  return match?.[0] ?? null;
}
