#!/usr/bin/env node
// Validate contracts/openapi.yaml against OpenAPI 3.1 and validate embedded examples.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

type JsonSchema = Record<string, unknown>;
type ValidateFn = {
  (value: unknown): boolean;
  errors?: Array<{ instancePath?: string; message?: string }>;
};
type AjvLike = { compile: (schema: JsonSchema) => ValidateFn };
type ExampleFailure = { path: string; message: string };

const Ajv2020 = Ajv2020Module as unknown as {
  new (options: Record<string, unknown>): AjvLike;
};
const addFormats = addFormatsModule as unknown as (ajv: AjvLike) => void;

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const openapiPath = path.join(projectRoot, 'contracts', 'openapi.yaml');
const checksumPath = path.join(projectRoot, 'contracts', 'openapi.checksum.txt');

function rel(p: string): string {
  return path.relative(projectRoot, p);
}

function validateExample(
  ajv: AjvLike,
  schema: JsonSchema,
  value: unknown,
  at: string,
): ExampleFailure[] {
  const validate = ajv.compile(schema);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error: { instancePath?: string; message?: string }) => ({
    path: at,
    message: `${error.instancePath || '/'} ${error.message ?? 'invalid example'}`.trim(),
  }));
}

function collectExampleFailures(node: unknown, ajv: AjvLike, at = '#'): ExampleFailure[] {
  if (!node || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  const failures: ExampleFailure[] = [];

  if ('schema' in obj && obj.schema && typeof obj.schema === 'object') {
    const schema = obj.schema as JsonSchema;
    if ('example' in obj) {
      failures.push(...validateExample(ajv, schema, obj.example, `${at}/example`));
    }
    if ('examples' in obj && obj.examples && typeof obj.examples === 'object') {
      for (const [key, wrapped] of Object.entries(obj.examples as Record<string, unknown>)) {
        if (
          wrapped &&
          typeof wrapped === 'object' &&
          'value' in (wrapped as Record<string, unknown>)
        ) {
          failures.push(
            ...validateExample(
              ajv,
              schema,
              (wrapped as Record<string, unknown>).value,
              `${at}/examples/${key}/value`,
            ),
          );
        }
      }
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    failures.push(...collectExampleFailures(value, ajv, `${at}/${key}`));
  }
  return failures;
}

async function main(): Promise<void> {
  const doc = readFileSync(openapiPath);
  const sha256 = createHash('sha256').update(doc).digest('hex');
  writeFileSync(checksumPath, `${sha256}  ${path.basename(openapiPath)}\n`);
  console.log(`wrote ${rel(checksumPath)} (sha256 ${sha256.slice(0, 12)}…)`);

  try {
    const api = await SwaggerParser.validate(openapiPath, { continueOnError: true });
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
    addFormats(ajv);
    const exampleFailures = collectExampleFailures(api, ajv);
    if (exampleFailures.length > 0) {
      console.error('openapi:validate failed: invalid examples');
      for (const failure of exampleFailures) {
        console.error(`  - ${failure.path}: ${failure.message}`);
      }
      process.exit(1);
    }
    const title = (api as { info?: { title?: string } }).info?.title ?? '(unknown)';
    const version = (api as { info?: { version?: string } }).info?.version ?? '(unknown)';
    console.log(`openapi ok: ${title} v${version}`);
  } catch (err: unknown) {
    const detail =
      err && typeof err === 'object' && 'message' in err
        ? String((err as { message: string }).message)
        : String(err);
    console.error(`openapi:validate failed: ${detail}`);
    if (err && typeof err === 'object' && 'errors' in err) {
      const list = (err as { errors: Array<{ message: string }> }).errors ?? [];
      for (const e of list) console.error(`  - ${e.message}`);
    }
    process.exit(1);
  }
}

void main();
