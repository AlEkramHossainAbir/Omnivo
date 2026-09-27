import { sql } from 'drizzle-orm';
import type { Db } from '@omnivo/db';

import { getTenantId } from './tenant-context.js';

export type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

export function createWithTenant(database: Db) {
  return async function withTenant<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const tenantId = getTenantId();
    return database.transaction(async (tx) => {
      // true = transaction-local — commit/rollback-এর সাথে এই সেটিংও যায়, PgBouncer-নিরাপদ
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx);
    });
  };
}

export type WithTenant = ReturnType<typeof createWithTenant>;