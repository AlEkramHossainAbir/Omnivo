import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export function createDb(connectionString: string) {
  const queryClient = postgres(connectionString);
  return drizzle(queryClient, { schema });
}

export type Db = ReturnType<typeof createDb>;

export const db = createDb(process.env.DATABASE_URL ?? '');