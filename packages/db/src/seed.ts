import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { tenants, users, memberships } from './schema/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
config({ path: path.join(repoRoot, '.env') });

async function main() {
  const client = postgres(process.env.MIGRATOR_DATABASE_URL!, { max: 1 });
  const db = drizzle(client);

  await db.transaction(async (tx) => {
    const [tenant] = await tx
      .insert(tenants)
      .values({ name: 'Acme Textiles', slug: 'acme' })
      .returning();

    const [user] = await tx
      .insert(users)
      .values({ email: 'admin@acme.omnivo.app', fullName: 'Acme Admin' })
      .returning();

    if (tenant && user) {
      // memberships টেবিলে FORCE ROW LEVEL SECURITY আছে, তাই insert-এর আগে
      // এই ট্রানজ্যাকশনে tenant context সেট করতে হবে — নাহলে policy insert ব্লক করবে।
      // true = transaction-local, tx কমিট/রোলব্যাক হলে এই সেটিংও সাথে যায়
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenant.id}, true)`);
      await tx.insert(memberships).values({ tenantId: tenant.id, userId: user.id });
    }
  });

  await client.end();
  console.log('seed done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
