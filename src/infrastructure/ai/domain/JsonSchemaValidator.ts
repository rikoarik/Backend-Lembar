/**
 * Minimal shape-only JSON-schema validator used by the AI spike.
 *
 * The spike keeps dependencies at "already installed" by reusing the same
 * Ajv2020/fact set that `scripts/openapi-validate.ts` already requires. We
 * expose a tiny wrapper so the AI domain layer does not depend on scripts/.
 *
 * ponytail: uses Ajv from `ajv/dist/2020.js` — a strict subset is enough here;
 * the real B3 blueprint/question pipeline will reuse the same validator with
 * richer schemas. Upgrade path: import `json-schema-validation` once a real
 * downstream consumer needs `$ref` resolving.
 */
import Ajv2020Module from 'ajv/dist/2020.js';

type JsonSchema = Record<string, unknown>;
type ValidateFn = {
  (value: unknown): boolean;
  errors?: Array<{ instancePath?: string; message?: string }>;
};
type AjvLike = { compile: (schema: JsonSchema) => ValidateFn };

const Ajv2020 = Ajv2020Module as unknown as {
  new (options: Record<string, unknown>): AjvLike;
};

export interface SchemaValidationResult {
  ok: boolean;
  errors: ReadonlyArray<{ instancePath: string; message: string }>;
}

export class JsonSchemaValidator {
  private readonly ajv: AjvLike;

  constructor() {
    this.ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  }

  validate(schema: JsonSchema, value: unknown): SchemaValidationResult {
    const validate = this.ajv.compile(schema);
    if (validate(value)) return { ok: true, errors: [] };
    const errors = (validate.errors ?? []).map((error) => ({
      instancePath: error.instancePath ?? '/',
      message: error.message ?? 'invalid',
    }));
    return { ok: false, errors };
  }
}
