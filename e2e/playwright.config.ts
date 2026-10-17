import { defineConfig } from '@playwright/test';

// Runs against an already-running app: `docker compose up` first.
// Each test creates its own items, so tests don't depend on each other or on order.
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
});
