#!/usr/bin/env node
// Compare contracts/openapi.yaml against contracts/openapi.previous.yaml (if present).
// Exit codes: 0 additive/no previous/no change, 1 breaking, 2 script error.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import SwaggerParser from '@apidevtools/swagger-parser';

type Operation = { responses?: Record<string, Response>; requestBody?: RequestBody };
type Response = { content?: Record<string, { schema?: unknown }> };
type RequestBody = { content?: Record<string, { schema?: { required?: string[] } }> };
type Doc = { paths?: Record<string, Record<string, Operation> | undefined> };
type Endpoint = { id: string; method: string; path: string; op: Operation };

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const currentPath = path.join(projectRoot, 'contracts', 'openapi.yaml');
const previousPath = path.join(projectRoot, 'contracts', 'openapi.previous.yaml');
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']);

function endpoints(doc: Doc): Map<string, Endpoint> {
  const out = new Map<string, Endpoint>();
  for (const [p, ops] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      const lower = method.toLowerCase();
      if (!HTTP_METHODS.has(lower)) continue;
      out.set(`${lower} ${p}`, { id: `${method.toUpperCase()} ${p}`, method: lower, path: p, op });
    }
  }
  return out;
}

function statusCodes(op: Operation): Set<string> {
  return new Set(Object.keys(op.responses ?? {}));
}

function requiredFields(op: Operation): Set<string> {
  return new Set(op.requestBody?.content?.['application/json']?.schema?.required ?? []);
}

function responseProperties(op: Operation, statusCode: string): Set<string> {
  const schema = op.responses?.[statusCode]?.content?.['application/json']?.schema as
    { properties?: Record<string, unknown> } | undefined;
  return new Set(Object.keys(schema?.properties ?? {}));
}

async function main(): Promise<void> {
  if (!existsSync(currentPath)) {
    console.error('missing contracts/openapi.yaml');
    process.exit(2);
  }
  if (!existsSync(previousPath)) {
    console.log('no baseline (contracts/openapi.previous.yaml); treating current as baseline.');
    process.exit(0);
  }

  let prevDoc: Doc;
  let currDoc: Doc;
  try {
    [prevDoc, currDoc] = (await Promise.all([
      SwaggerParser.dereference(previousPath),
      SwaggerParser.dereference(currentPath),
    ])) as [Doc, Doc];
  } catch (err) {
    console.error('failed to parse contracts:', err instanceof Error ? err.message : err);
    process.exit(2);
  }

  const prev = endpoints(prevDoc);
  const curr = endpoints(currDoc);
  const additive: string[] = [];
  const breaking: string[] = [];

  for (const [key, p] of prev) if (!curr.has(key)) breaking.push(`endpoint removed: ${p.id}`);
  for (const [key, c] of curr) if (!prev.has(key)) additive.push(`endpoint added: ${c.id}`);

  for (const [key, p] of prev) {
    const c = curr.get(key);
    if (!c) continue;

    const prevStatuses = statusCodes(p.op);
    const currStatuses = statusCodes(c.op);
    for (const status of prevStatuses) {
      if (!currStatuses.has(status)) breaking.push(`status removed: ${p.id} ${status}`);
    }

    const prevRequired = requiredFields(p.op);
    const currRequired = requiredFields(c.op);
    for (const field of currRequired) {
      if (!prevRequired.has(field))
        breaking.push(`new required request field: ${p.id} -> ${field}`);
    }

    for (const status of prevStatuses) {
      if (!currStatuses.has(status)) continue;
      const prevProps = responseProperties(p.op, status);
      const currProps = responseProperties(c.op, status);
      for (const prop of prevProps) {
        if (!currProps.has(prop))
          breaking.push(`response property removed: ${p.id} ${status} -> ${prop}`);
      }
      for (const prop of currProps) {
        if (!prevProps.has(prop))
          additive.push(`response property added: ${p.id} ${status} -> ${prop}`);
      }
    }
  }

  console.log(`openapi:breaking — additive: ${additive.length}, breaking: ${breaking.length}`);
  for (const line of additive) console.log(`+ ${line}`);
  if (breaking.length > 0) {
    for (const line of breaking) console.log(`! ${line}`);
    process.exit(1);
  }
  console.log('openapi:breaking — no breaking changes.');
}

void main();
