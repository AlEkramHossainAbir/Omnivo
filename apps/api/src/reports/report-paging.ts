import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// What the step 21b reports share: the raw rows checked with a schema, and their pages.

// Raw rows are data from outside TypeScript's view: checked with a schema, never cast
export async function select<S extends z.ZodType>(
  tx: Transaction,
  query: SQL,
  row: S,
): Promise<z.output<S>[]> {
  return z.array(row).parse(await tx.execute(query));
}

// A report's rows are sums: every page adds up all of the period's lines again, and only then
// sorts them. So the cursor is the place in the sorted list (an OFFSET), not the last row's
// values: a keyset cursor would save nothing (the sums are worked out either way), and a sum, a
// percent or a name that is null does not make a clean keyset. If the numbers change between two
// pages, a row can show twice or be missed, as with any cursor over a moving total; the export
// has every row in one read.
export interface ReportPage {
  limit: number;
  offset: number;
}

const offsetCursor = z.tuple([z.number().int().min(0)]);

// The page a query asks for. The cursor is checked like every other one: a broken or edited cursor
// is invalid_cursor (400), never a SQL error.
export function reportPage(query: { limit: number; cursor?: string | undefined }): ReportPage {
  const after = decodeCursor(query.cursor, offsetCursor);
  return { limit: query.limit, offset: after?.[0] ?? 0 };
}

// One row more than the page, to know whether there is a next one. null = every row (an export).
export function pageClause(page: ReportPage | null): SQL {
  if (page === null) return sql``;
  return sql`LIMIT ${page.limit + 1} OFFSET ${page.offset}`;
}

// The page's rows and the cursor of the next one (null on the last page and for an export)
export function pageRows<T>(
  found: readonly T[],
  page: ReportPage | null,
): { items: T[]; nextCursor: string | null } {
  if (page === null) return { items: [...found], nextCursor: null };
  return {
    items: found.slice(0, page.limit),
    nextCursor: found.length > page.limit ? encodeCursor([page.offset + page.limit]) : null,
  };
}

// The categories a filter means: this one and every one under it (decision 13), the same rule
// as the product list (products.service.ts)
export function inCategory(column: SQL, tenantId: string, categoryId: string): SQL {
  return sql`${column} IN (
    WITH RECURSIVE down AS (
      SELECT id FROM product_categories WHERE tenant_id = ${tenantId}::uuid AND id = ${categoryId}::uuid
      UNION ALL
      SELECT c.id FROM product_categories c JOIN down ON c.parent_id = down.id
       WHERE c.tenant_id = ${tenantId}::uuid
    ) SELECT id FROM down)`;
}

// A sort's column and direction: "net" sorts up, "-net" down. `columns` has one SQL expression per
// column name; written with `satisfies Record<…, SQL>` at the caller, so a sort the contract adds
// without a column fails the type check. A sort that matches nothing is a bug, not a request.
export function sortColumn(
  sort: string,
  columns: Readonly<Record<string, SQL>>,
): { column: SQL; direction: SQL } {
  for (const [name, column] of Object.entries(columns)) {
    if (sort === name) return { column, direction: sql`ASC` };
    if (sort === `-${name}`) return { column, direction: sql`DESC` };
  }
  throw new Error(`No column for the sort ${sort}`);
}

// The column names of a list of sorts: 'net' from 'net' and '-net'
export type SortColumn<S extends string> = Exclude<S, `-${string}`>;
