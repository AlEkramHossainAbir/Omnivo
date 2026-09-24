import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function main() {
  const migrationClient = postgres(process.env.MIGRATOR_DATABASE_URL!, { max: 1 });
  const db = drizzle(migrationClient);
  await migrate(db, { migrationsFolder: './migrations' });
  await migrationClient.end();
  console.log('migrations done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
