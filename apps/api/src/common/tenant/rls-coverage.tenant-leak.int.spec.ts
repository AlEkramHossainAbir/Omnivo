import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startPostgres, type TestPostgres } from '../../testing/containers.js';

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startPostgres();
}, 120_000);

afterAll(async () => {
  await pg.container.stop();
});

// build-plan §৬-এর ঝুঁকি "নতুন টেবিলে RLS ভুলে যাওয়া"-র পাহারা: tenant_id কলাম আছে এমন প্রতিটা টেবিলে
// ENABLE + FORCE RLS আর অন্তত একটা policy। নতুন টেবিলের migration-এ RLS লিখতে ভুলে গেলে এই টেস্ট
// টেবিলের নাম ধরে fail করে — leak হওয়ার আগে, PR-এই
describe('row-level security coverage', () => {
  it('protects every table that has a tenant_id column', async () => {
    const sql = postgres(pg.superuserUrl, { max: 1 });
    const rows = await sql<
      { table: string; enabled: boolean; forced: boolean; policies: number }[]
    >`
      SELECT c.relname AS table,
             c.relrowsecurity AS enabled,
             c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE c.relkind = 'r'
      ORDER BY c.relname`;
    await sql.end();

    expect(rows.length).toBeGreaterThanOrEqual(10);
    const unprotected = rows
      .filter((row) => !row.enabled || !row.forced || row.policies === 0)
      .map((row) => row.table);
    expect(unprotected).toEqual([]);
  });
});
