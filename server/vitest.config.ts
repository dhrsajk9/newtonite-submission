import { defineConfig } from 'vitest/config';

// Tests run against a real Postgres, in a separate database that is wiped and
// rebuilt on every run. Concurrency and locking bugs don't show up with mocks.
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/newtonite_test';

// Set before anything imports src/config.ts, so the app's pool points at the test DB.
process.env.DATABASE_URL = testDatabaseUrl;
process.env.NODE_ENV = 'test';
process.env.SEED_ITEM_COUNT = '300';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    env: { DATABASE_URL: testDatabaseUrl, NODE_ENV: 'test', SEED_ITEM_COUNT: '300' },
    // Test files share one database, so run them one file at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
