import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export interface CreateDbOptions {
  max?: number;
}

// import-time singleton না: কোন DB-তে কানেক্ট করবে সেটা caller ঠিক করবে
// (API-তে DATABASE_URL, leak test-এ Testcontainers-এর URL)
export function createDb(connectionString: string, options: CreateDbOptions = {}) {
  const queryClient = postgres(connectionString, options);
  return drizzle(queryClient, { schema });
}

export type Db = ReturnType<typeof createDb>;