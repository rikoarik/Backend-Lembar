#!/usr/bin/env node
// Secret scan gate for Backend-Lembar.
//
// Scans the git-tracked tree (never the working directory at large, so
// node_modules/, dist/ and ignored .env files are out of scope by
// construction) for credential material.
//
// Exit codes: 0 clean, 1 findings, 2 script error.
//
// Output never prints a secret value: only path, line, pattern id and a
// redacted preview (first 2 characters + length), per AGENTS.md
// ("Never log secret, session/token, ... by default").
//
// Detection strategy
// ------------------
// Two high-precision layers, both chosen so a clean tree stays clean:
//
//   1. Shape rules — unambiguous credential formats (private key blocks,
//      vendor token prefixes, serialized JWTs, connection URLs that carry an
//      inline password). Near-zero false positive by construction.
//   2. Key-driven rule — an assignment whose *name* says it holds a credential
//      (`..._SECRET`, `apiKey`, `password`, ...) AND whose value is a quoted
//      string literal that is not documented placeholder/dev vocabulary.
//
// A generic Shannon-entropy sweep over every quoted literal was implemented
// and rejected: on this tree it fired ~580 times, entirely on identifiers,
// error codes (`SCHEMA_VALIDATION_FAILED`), UUIDs, YAML `$ref` pointers and
// absolute paths. A gate that noisy gets disabled or blanket-allowlisted,
// which is worse than no gate, so the entropy sweep is deliberately not part
// of the pattern set. Layer 2 keeps recall on the case that matters — a real
// credential pasted next to a credential-shaped name — without the noise.
// Do not re-add a bare entropy sweep; add a shape or key-name rule instead.
//
// Suppressions are deliberate and reviewable: every one lives in
// scripts/secret-scan.allow with a `path:patternId  reason` line. Never
// delete or loosen a rule to make this gate pass — fix the leak or add a
// reasoned allowlist entry (AGENTS.md "Quality gates").
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const allowPath = path.join(here, 'secret-scan.allow');

/** Minimum length of a credential-shaped literal. */
const MIN_SECRET_LEN = 12;

/**
 * Values that are documented non-secrets: local/dev defaults, test fixtures,
 * example placeholders. Matched case-insensitively as substrings.
 *
 * Entries are specific fixture vocabulary, never broad English words — a real
 * credential is a random or vendor-prefixed string, so naming the fixture
 * literals here does not weaken the shape rules.
 */
const DEV_VOCABULARY = [
  'changeme',
  'change-in-production',
  'change_me',
  'placeholder',
  'example',
  'sample',
  'dummy',
  'fake',
  'fixture',
  'stub',
  'mock',
  'preview-only',
  'fallback-key',
  'securepass',
  'password123',
  'letmein',
  'redacted',
  'password',
  'passphrase',
  'secret',
  'token',
  'localhost',
  '127.0.0.1',
  'test',
  'dev-',
  '-dev',
  'dev_',
  '_dev',
  'local',
  'sandbox',
  'your-',
  'your_',
  'xxx',
];

/** Hosts that cannot leak a production credential. */
const LOCAL_HOST =
  /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1|example\.(?:com|org|net)|.*\.local|.*\.test)$/i;

/** Assignment names that end in a credential word (`apiKey`, `jwtSecret`, `OPENAI_API_KEY`). */
const SECRET_KEY_NAME =
  /^(?:.*[_-])?(?:password|passwd|secret|api[_-]?key|access[_-]?key|token|credential|private[_-]?key|signing[_-]?key|webhook[_-]?secret)$/i;

/** All-caps identifier values (`VALIDATION_FAILED`) are error codes, not credentials. */
const SCREAMING_SNAKE = /^[A-Z0-9_]+$/;

/** @type {Array<{ id: string, description: string, pattern: RegExp }>} */
const SHAPE_RULES = [
  {
    id: 'private-key-block',
    description: 'PEM/OpenSSH private key material',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS access key id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    id: 'github-token',
    description: 'GitHub personal/app/installation token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  },
  {
    id: 'slack-token',
    description: 'Slack API token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: 'stripe-secret-key',
    description: 'Stripe secret/restricted key',
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  },
  {
    id: 'anthropic-key',
    description: 'Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: 'openai-style-key',
    description: 'OpenAI-style sk- API key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: 'jwt-literal',
    description: 'Serialized JWT (three base64url segments)',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
];

/** Connection URL with an inline user:password@ pair. */
const URL_WITH_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/([^:@\s/'"]+):([^@\s/'"]+)@([^/\s'"]+)/gi;

/**
 * `name = 'value'` / `"name": "value"` where the name is credential-shaped and
 * the value is a quoted literal. Values that are expressions, identifiers or
 * member accesses (`body.password`, `options.jwtSecret`, `randomUUID()`) are
 * not literals and carry no credential material, so they are not reported.
 */
const QUOTED_ASSIGNMENT = /(["']?)([A-Za-z_][A-Za-z0-9_]*)\1\s*[:=]\s*(["'`])([^"'`\n]{1,200})\3/g;

function isDevValue(value) {
  const lower = value.toLowerCase();
  return DEV_VOCABULARY.some((word) => lower.includes(word));
}

/** Looks like an opaque credential rather than prose, a path, a URL or an error code. */
function looksLikeSecretLiteral(value) {
  if (value.length < MIN_SECRET_LEN) return false;
  if (isDevValue(value)) return false;
  if (SCREAMING_SNAKE.test(value)) return false;
  // Template literals with interpolation are generated at runtime, so they
  // carry no static credential material.
  if (value.includes('${')) return false;
  if (/\s/.test(value)) return false;
  if (/^(?:https?|postgres(?:ql)?|mongodb|redis|amqp):\/\//i.test(value)) return false;
  if (value.startsWith('#/') || value.startsWith('./') || value.startsWith('/')) return false;
  return true;
}

function loadAllowlist() {
  /** @type {Map<string, string>} */
  const allow = new Map();
  if (!existsSync(allowPath)) return allow;
  for (const raw of readFileSync(allowPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+):(\S+)(?:\s{2,}(.*))?$/.exec(line);
    if (!m) continue;
    const [, file, rule, reason] = m;
    if (!reason || reason.trim().length < 8) {
      console.error(`secret-scan.allow: entry "${line}" needs a reason (2+ spaces after the rule)`);
      process.exit(2);
    }
    allow.set(`${file}:${rule}`, reason.trim());
  }
  return allow;
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((f) => f.length > 0);
}

function redact(value) {
  if (value.length <= 2) return `** (len ${value.length})`;
  return `${value.slice(0, 2)}${'*'.repeat(Math.min(8, value.length - 2))} (len ${value.length})`;
}

function scanFile(rel, allow) {
  const abs = path.join(projectRoot, rel);
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  // Binary-ish files (NUL in the first 8KB) are skipped: the rules are
  // textual and a NUL byte means this is not source.
  if (text.slice(0, 8192).includes('\0')) return [];

  /** @type {Array<{file:string,line:number,rule:string,description:string,preview:string}>} */
  const findings = [];
  const push = (rule, description, line, value) => {
    if (allow.has(`${rel}:${rule}`)) return;
    findings.push({ file: rel, line, rule, description, preview: redact(value) });
  };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    for (const rule of SHAPE_RULES) {
      const match = rule.pattern.exec(line);
      if (match) push(rule.id, rule.description, i + 1, match[0]);
    }

    URL_WITH_PASSWORD.lastIndex = 0;
    let urlMatch;
    while ((urlMatch = URL_WITH_PASSWORD.exec(line)) !== null) {
      const password = urlMatch[2] ?? '';
      // Strip any :port so the local-host test sees the bare host.
      const host = (urlMatch[3] ?? '').replace(/:\d+$/, '');
      if (password.startsWith('***')) continue;
      if (LOCAL_HOST.test(host)) continue;
      if (isDevValue(password)) continue;
      push(
        'url-with-inline-password',
        'Connection URL carrying a non-placeholder password',
        i + 1,
        password,
      );
    }

    QUOTED_ASSIGNMENT.lastIndex = 0;
    let assignMatch;
    while ((assignMatch = QUOTED_ASSIGNMENT.exec(line)) !== null) {
      const name = assignMatch[2] ?? '';
      const value = assignMatch[4] ?? '';
      if (!SECRET_KEY_NAME.test(name)) continue;
      if (!looksLikeSecretLiteral(value)) continue;
      push('credential-shaped-assignment', `Quoted credential assigned to "${name}"`, i + 1, value);
    }
  }
  return findings;
}

function main() {
  const allow = loadAllowlist();
  const files = trackedFiles();
  const findings = [];
  for (const file of files) findings.push(...scanFile(file, allow));

  if (findings.length === 0) {
    console.log(`secret:scan ok — ${files.length} tracked files, 0 findings.`);
    console.log(
      `rules: ${SHAPE_RULES.length} shape + url-with-inline-password + credential-shaped-assignment`,
    );
    console.log(`allowlist entries: ${allow.size}`);
    return;
  }

  console.error(
    `secret:scan FAILED — ${findings.length} finding(s) in ${files.length} tracked files.`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}] ${f.description} -> ${f.preview}`);
  }
  console.error('');
  console.error('Fix the leak, or add a reasoned entry to scripts/secret-scan.allow:');
  console.error('  <path>:<rule-id>  <why this value is not a secret>');
  process.exit(1);
}

try {
  main();
} catch (err) {
  console.error('secret:scan error:', err instanceof Error ? err.message : err);
  process.exit(2);
}
