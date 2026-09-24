import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { loadRootEnv, requireEnv } from './env.js';

loadRootEnv();

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

async function main() {
  const migrationClient = postgres(requireEnv('MIGRATOR_DATABASE_URL'), { max: 1 });
  const db = drizzle(migrationClient);
  await migrate(db, { migrationsFolder });
  await migrationClient.end();
  console.log('migrations done');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
