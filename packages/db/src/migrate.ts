import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { loadRootEnv, requireEnv } from './env.js';
import { grantOwnerPermissions, syncPermissions } from './permission-catalog.js';

loadRootEnv();

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

async function main() {
  const migrationClient = postgres(requireEnv('MIGRATOR_DATABASE_URL'), { max: 1 });
  const db = drizzle(migrationClient);
  await migrate(db, { migrationsFolder });
  // permissions সিস্টেম ডেটা — schema-র মতোই প্রতিটা deploy-এ কোডের তালিকার সাথে মেলানো
  await syncPermissions(db);
  // নতুন permission পুরনো workspace-এর Owner-কেও — নাহলে এই ধাপের স্ক্রিনগুলো মালিক নিজেই খুলতে পারত না
  await grantOwnerPermissions(db);
  await migrationClient.end();
  console.log('migrations done');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
