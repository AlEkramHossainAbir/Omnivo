import { Inject, Injectable } from '@nestjs/common';
import { addMoney, type LedgerPage, subtractMoney } from '@omnivo/contracts';
import { journalEntries, journalLines, ledgerAccounts } from '@omnivo/db';
import { and, asc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { notFound } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// A ledger row's position: its entry's date, then the line's id (UUIDv7, so the order lines were
// written in). Together they are unique and never change once posted — a stable page order.
const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// debit − credit of the matching posted lines. round(…, 4): "0.0000" when nothing matches.
function balanceWhere(condition: SQL | undefined): SQL<string> {
  const filter = condition ?? sql`true`;
  return sql<string>`round(coalesce(sum(${journalLines.debit} - ${journalLines.credit}) FILTER (WHERE ${filter}), 0), 4)`;
}

@Injectable()
export class LedgerService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  ledger(
    accountId: string,
    query: {
      limit: number;
      cursor?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
    },
  ): Promise<LedgerPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const [account] = await tx
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.id, accountId)));
      if (!account) throw notFound('Account');

      // Only posted lines of this account. A draft is not in the books yet.
      const ofAccount = and(
        eq(journalLines.tenantId, tenantId),
        eq(journalLines.accountId, accountId),
        eq(journalEntries.status, 'posted'),
      );
      const joined = and(
        eq(journalEntries.tenantId, journalLines.tenantId),
        eq(journalEntries.id, journalLines.entryId),
      );
      const position = sql`(${journalEntries.date}, ${journalLines.id})`;
      const beforeFrom =
        query.from === undefined ? undefined : sql`${journalEntries.date} < ${query.from}::date`;

      const rows = await tx
        .select({
          lineId: journalLines.id,
          entryId: journalEntries.id,
          number: journalEntries.number,
          date: journalEntries.date,
          narration: journalEntries.narration,
          description: journalLines.description,
          debit: journalLines.debit,
          credit: journalLines.credit,
        })
        .from(journalLines)
        .innerJoin(journalEntries, joined)
        .where(
          and(
            ofAccount,
            query.from === undefined
              ? undefined
              : sql`${journalEntries.date} >= ${query.from}::date`,
            query.to === undefined ? undefined : sql`${journalEntries.date} <= ${query.to}::date`,
            after === undefined
              ? undefined
              : sql`${position} > (${after[0]}::date, ${after[1]}::uuid)`,
          ),
        )
        .orderBy(asc(journalEntries.date), asc(journalLines.id))
        .limit(query.limit + 1);

      // Three balances in one pass over the account's lines:
      // - before this page: everything up to the cursor (or before `from` on the first page),
      //   so page 3's running balance continues exactly where page 2 stopped;
      // - opening: before `from`; closing: up to `to`.
      const [sums] = await tx
        .select({
          beforePage: balanceWhere(
            after === undefined
              ? (beforeFrom ?? sql`false`)
              : sql`${position} <= (${after[0]}::date, ${after[1]}::uuid)`,
          ),
          opening: balanceWhere(beforeFrom ?? sql`false`),
          closing: balanceWhere(
            query.to === undefined ? undefined : sql`${journalEntries.date} <= ${query.to}::date`,
          ),
        })
        .from(journalLines)
        .innerJoin(journalEntries, joined)
        .where(ofAccount);
      if (!sums) throw new Error('Ledger sums returned no row');

      const page = toPage(rows, query.limit, (last) => [last.date, last.lineId]);
      let balance = sums.beforePage;
      return {
        items: page.items.map((row) => {
          balance = addMoney(balance, subtractMoney(row.debit, row.credit));
          // Every line here is posted, so it has a number
          return { ...row, number: row.number ?? '', balance };
        }),
        nextCursor: page.nextCursor,
        openingBalance: sums.opening,
        closingBalance: sums.closing,
      };
    });
  }
}
