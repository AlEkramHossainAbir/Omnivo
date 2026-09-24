import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

// import-time singleton না: কোন DB-তে কানেক্ট করবে সেটা caller ঠিক করবে
// (API-তে DATABASE_URL, leak test-এ Testcontainers-এর URL)
export function createDb(connectionString: string) {
  const queryClient = postgres(connectionString);
  return drizzle(queryClient, { schema });
}

export type Db = ReturnType<typeof createDb>;
