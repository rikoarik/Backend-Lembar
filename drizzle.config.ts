import { defineConfig } from 'drizzle-kit';

const url = process.env['DATABASE_URL'] ?? '';

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/infrastructure/database/schema.ts',
    './src/infrastructure/queue/persistence/schema.ts',
  ],
  out: './src/infrastructure/database/migrations',
  dbCredentials: { url },
  strict: true,
  verbose: false,
});
