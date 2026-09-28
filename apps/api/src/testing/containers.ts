import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { syncPermissions } from '@omnivo/db';

// src/testing → src → api → apps → repo root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export interface TestPostgres {
  container: StartedPostgreSqlContainer;
  superuserUrl: string;
  appUrl: string;
}

// docker-compose-এর মতোই: superuser দিয়ে role, migrator দিয়ে migration + permission sync
export async function startPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('omnivo')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

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
  const migratorDb = drizzle(migratorClient);
  await migrate(migratorDb, { migrationsFolder: path.join(repoRoot, 'packages/db/migrations') });
  await syncPermissions(migratorDb);
  await migratorClient.end();

  return {
    container,
    superuserUrl: container.getConnectionUri(),
    appUrl: urlFor('omnivo_app', 'app_dev_password'),
  };
}

export interface TestRedis {
  container: StartedTestContainer;
  url: string;
}

// docker-compose-এর cache সার্ভিসের একই image
export async function startRedis(): Promise<TestRedis> {
  const container = await new GenericContainer('valkey/valkey:8-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  return {
    container,
    url: `redis://${container.getHost()}:${String(container.getMappedPort(6379))}`,
  };
}
