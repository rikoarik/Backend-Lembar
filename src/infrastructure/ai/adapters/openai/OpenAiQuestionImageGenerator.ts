import type { ImageGenerationEnv } from '../../../../config/image-generation.env.js';
import type {
  QuestionImage,
  QuestionImageGenerationRequest,
  QuestionImageGenerator,
} from '../../../../modules/assessments/domain/QuestionGeneration.js';

const MAX_IMAGE_BYTES = 2_500_000;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

type FetchImplementation = typeof fetch;

export interface OpenAiQuestionImageGeneratorOptions {
  env: ImageGenerationEnv;
  fetchImplementation?: FetchImplementation;
}

export class OpenAiQuestionImageGenerator implements QuestionImageGenerator {
  private readonly fetchImplementation: FetchImplementation;

  constructor(private readonly options: OpenAiQuestionImageGeneratorOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async generate(request: QuestionImageGenerationRequest): Promise<QuestionImage | null> {
    const { env } = this.options;
    if (!env.enabled || !env.apiKey) return null;

    const prompt = buildProviderPrompt(request);
    if (!prompt) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.timeoutMs);

    try {
      const response = await this.fetchImplementation(`${env.baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: env.modelId,
          prompt,
          n: 1,
          size: '1024x1024',
          quality: 'low',
          output_format: 'webp',
          output_compression: 75,
        }),
        signal: controller.signal,
      });

      if (!response.ok) return null;

      const payload = (await response.json().catch(() => null)) as
        | { data?: Array<{ b64_json?: unknown }> }
        | null;
      const encoded = payload?.data?.[0]?.b64_json;
      if (typeof encoded !== 'string') return null;

      const decoded = decodeBoundedBase64(encoded);
      if (!decoded) return null;

      const mimeType = detectMimeType(decoded);
      if (!mimeType) return null;

      return {
        dataUrl: `data:${mimeType};base64,${encoded}`,
        alt: request.alt.trim().slice(0, 300),
        mimeType,
        providerModelId: env.modelId,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildProviderPrompt(request: QuestionImageGenerationRequest): string {
  const prompt = request.prompt.trim().slice(0, 1_500);
  if (!prompt) return '';

  const styleInstruction =
    request.style === 'diagram'
      ? 'Create a clean educational diagram with a plain background and precise geometry.'
      : request.style === 'illustration'
        ? 'Create a clear, age-appropriate educational illustration with restrained detail.'
        : 'Choose either a clean diagram or an educational illustration, whichever best supports the question.';

  return `${styleInstruction}\n${prompt}\nDo not include decorative elements. Do not reveal or visually hint at the answer. Avoid text and labels unless essential.`;
}

function decodeBoundedBase64(value: string): Buffer | null {
  if (value.length === 0 || value.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) return null;
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return null;

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.length > MAX_IMAGE_BYTES) return null;
  if (decoded.toString('base64') !== value) return null;
  return decoded;
}

function detectMimeType(value: Buffer): QuestionImage['mimeType'] | null {
  if (
    value.length >= 12 &&
    value.subarray(0, 4).toString('ascii') === 'RIFF' &&
    value.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  if (
    value.length >= 8 &&
    value[0] === 0x89 &&
    value.subarray(1, 4).toString('ascii') === 'PNG' &&
    value[4] === 0x0d &&
    value[5] === 0x0a &&
    value[6] === 0x1a &&
    value[7] === 0x0a
  ) {
    return 'image/png';
  }

  return null;
}
