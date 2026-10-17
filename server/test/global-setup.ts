// Runs once before all tests: creates the test database if needed, wipes it,
// applies every migration and loads the seed data.
import pg from 'pg';

export default async function setup() {
  const url = new URL(process.env.DATABASE_URL!);
  const dbName = url.pathname.slice(1);

  // Safety catch: never wipe a database that isn't clearly a test database.
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${dbName}": the database name must end in _test.`);
  }

  // Create the test database if it doesn't exist (connect to the default "postgres" DB to do it).
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  // Start from an empty schema every run, so results never depend on leftovers.
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();

  // Imported here (not at the top) so they pick up the test DATABASE_URL.
  const { migrate } = await import('../src/db/migrate.js');
  const { seed } = await import('../src/db/seed.js');
  const { pool } = await import('../src/db/pool.js');
  await migrate();
  await seed();
  await pool.end();
}
