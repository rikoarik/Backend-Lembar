// Load .env file
const fs = require('fs');
const path = require('path');
const envPath = path.join('/home/hermes/Projects/Backend-Lembar', '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  const value = trimmed.slice(eqIdx + 1).trim();
  env[key] = value;
}

module.exports = {
  apps: [
    {
      name: 'lembar-api',
      script: 'pnpm',
      args: 'run start:api',
      cwd: '/home/hermes/Projects/Backend-Lembar',
      env: {
        ...env,
        NODE_ENV: 'production',
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
    },
  ],
};
