import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, memberships, tenants, users } from '@omnivo/db';

import { runWithTenant } from './tenant-context.js';
import { createWithTenant, type WithTenant } from './with-tenant.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

let container: StartedPostgreSqlContainer;
let appDb: Db;
let withTenant: WithTenant;
let tenantAId: string;
let tenantBId: string;

async function seedTenant(slug: string): Promise<string> {
  const [tenant] = await appDb.insert(tenants).values({ name: slug, slug }).returning();
  const [user] = await appDb
    .insert(users)
    .values({ email: `${slug}@example.com`, fullName: slug })
    .returning();
  if (!tenant || !user) throw new Error('seed failed');

  await runWithTenant(tenant.id, () =>
    withTenant(async (tx) => {
      await tx.insert(memberships).values({ tenantId: tenant.id, userId: user.id });
    }),
  );
  return tenant.id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('omnivo')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  // superuser URL থেকে বাকি দুই role-এর URL বানানো — host/port হাতে জোড়া লাগাতে হয় না
  const urlFor = (username: string, password: string): string => {
    const url = new URL(container.getConnectionUri());
    url.username = username;
    url.password = password;
    return url.toString();
  };

  const admin = postgres(container.getConnectionUri(), { max: 1 });
  await admin.unsafe(
    readFileSync(path.join(repoRoot, 'infra/docker/postgres/init/01-roles.sql'), 'utf-8'),
  );
  await admin.end();

  const migratorClient = postgres(urlFor('omnivo_migrator', 'migrator_dev_password'), { max: 1 });
  await migrate(drizzle(migratorClient), {
    migrationsFolder: path.join(repoRoot, 'packages/db/migrations'),
  });
  await migratorClient.end();

  appDb = createDb(urlFor('omnivo_app', 'app_dev_password'), { max: 1 });
  withTenant = createWithTenant(appDb);

  tenantAId = await seedTenant('tenant-a');
  tenantBId = await seedTenant('tenant-b');
}, 120_000);

afterAll(async () => {
  await appDb.$client.end();
  await container.stop();
});

describe('tenant isolation (RLS)', () => {
  it('tenant A cannot read tenant B rows, even when explicitly filtering by B', async () => {
    const leaked = await runWithTenant(tenantAId, () =>
      withTenant((tx) => tx.select().from(memberships).where(eq(memberships.tenantId, tenantBId))),
    );
    expect(leaked).toHaveLength(0);
  });

  it('tenant A sees exactly its own rows', async () => {
    const own = await runWithTenant(tenantAId, () =>
      withTenant((tx) => tx.select().from(memberships)),
    );
    expect(own).toHaveLength(1);
    expect(own[0]?.tenantId).toBe(tenantAId);
  });

  it('without a tenant context the app role sees nothing', async () => {
    const rows = await appDb.select().from(memberships);
    expect(rows).toHaveLength(0);
  });

  it('tenant A cannot write a row for tenant B', async () => {
    const [userRow] = await appDb.select().from(users).limit(1);
    if (!userRow) throw new Error('no user');
    await expect(
      runWithTenant(tenantAId, () =>
        withTenant(async (tx) => {
          await tx.insert(memberships).values({ tenantId: tenantBId, userId: userRow.id });
        }),
      ),
    ).rejects.toThrow();
  });

  it('the tenant setting does not survive the transaction on a reused connection', async () => {
    await runWithTenant(tenantAId, () => withTenant((tx) => tx.select().from(memberships)));
    const rows = await appDb.select().from(memberships);
    expect(rows).toHaveLength(0);
  });

  it('withTenant fails loudly outside a tenant context', async () => {
    await expect(withTenant((tx) => tx.select().from(memberships))).rejects.toThrow(
      /No tenant context/,
    );
  });
});