module.exports = {
  apps: [
    {
      name: 'lembar-api',
      script: 'pnpm',
      args: 'run start:api',
      cwd: '/home/hermes/Projects/Backend-Lembar',
      env: {
        NODE_ENV: 'production',
        SWAGGER_ENABLED: 'true',
        JWT_SECRET: 'lembar-jwt-secret-change-in-production-2026',
        JWT_EXPIRY_DAYS: '7',
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
    },
  ],
};
