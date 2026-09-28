import { sql } from 'drizzle-orm';
import type { Db } from '@omnivo/db';

import type { Transaction } from './with-tenant.js';

// tenant context ছাড়া "এই ইউজারের নিজের membership" পড়ার জন্য — migration 0004-এর
// own_memberships policy শুধু app.user_id দেখে, আর সেটা শুধু SELECT-এ কাজ করে
export function createWithUser(database: Db) {
  return async function withUser<T>(
    userId: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return database.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
      return fn(tx);
    });
  };
}

export type WithUser = ReturnType<typeof createWithUser>;
