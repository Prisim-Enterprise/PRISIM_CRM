// Starts a self-contained PostgreSQL 17 for local development (no install needed).
// Data lives in ./.pgdata. Production uses a real PostgreSQL server (see docs/DEPLOYMENT.md).
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, '.pgdata');
const port = Number(process.env.DEV_DB_PORT || 5433);

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'prisim',
  password: 'prisim_dev',
  port,
  persistent: true,
  onLog: () => {},
});

const fresh = !existsSync(join(dataDir, 'PG_VERSION'));
if (fresh) {
  console.log('[db] Initialising new local database cluster...');
  await pg.initialise();
}
await pg.start();
if (fresh) await pg.createDatabase('prisim_crm');
console.log(`[db] PostgreSQL running on localhost:${port} (db: prisim_crm, user: prisim)`);

const stop = async () => {
  console.log('\n[db] Stopping PostgreSQL...');
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
