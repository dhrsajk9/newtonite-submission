import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';

const app = buildApp();

app.listen({ port: config.port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Graceful shutdown: stop accepting requests, finish in-flight ones, close DB connections.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
