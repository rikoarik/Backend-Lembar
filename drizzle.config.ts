import { defineConfig } from 'drizzle-kit';

const url = process.env['DATABASE_URL'] ?? '';

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/infrastructure/database/schema.ts',
    './src/infrastructure/queue/persistence/schema.ts',
    './src/infrastructure/ai/persistence/schema.ts',
    './src/modules/curriculum/persistence/schema.ts',
    './src/modules/notifications/persistence/schema.ts',
    './src/modules/auth/persistence/schema.ts',
    './src/modules/uploads/persistence/schema.ts',
  ],
  out: './src/infrastructure/database/migrations',
  dbCredentials: { url },
  strict: true,
  verbose: false,
});
