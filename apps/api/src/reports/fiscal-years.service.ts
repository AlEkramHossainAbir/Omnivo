import { Inject, Injectable } from '@nestjs/common';
import {
  absMoney,
  type FiscalYear,
  fiscalYearLabel,
  type FiscalYearList,
  fiscalYearOf,
  isNegativeMoney,
  isZeroMoney,
  naturalAmount,
  shiftIsoDate,
  sumMoney,
  todayIn,
} from '@omnivo/contracts';
import { tenantSettings } from '@omnivo/db';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created } from '../common/audit/audit.js';
import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import {
  assertPeriodOpen,
  lockBooks,
  readLock,
  writeLockDate,
} from '../journal/period-lock.service.js';
import { type LineInput, PostingService } from '../journal/posting.service.js';
import { dailyProfit, profitAndLossBalances } from './report-queries.js';

interface YearSettings {
  startMonth: number;
  timezone: string;
}

const closingEntrySchema = z.object({ id: z.uuid(), number: z.string(), date: z.iso.date() });
type ClosingEntry = z.output<typeof closingEntrySchema>;

async function readSettings(tx: Transaction): Promise<YearSettings> {
  const [row] = await tx
    .select({ startMonth: tenantSettings.fiscalYearStartMonth, timezone: tenantSettings.timezone })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, getTenantId()));
  if (!row) throw new Error(`tenant_settings row missing for tenant ${getTenantId()}`);
  return row;
}

// The closing entries still in force: posted, and not undone by a reopen. Plain SQL, like the
// reports: one anti-join says it.
async function closingEntries(tx: Transaction): Promise<ClosingEntry[]> {
  const rows = await tx.execute(sql`
    SELECT e.id::text, e.number, e.date::text
      FROM journal_entries e
     WHERE e.tenant_id = ${getTenantId()}::uuid
       AND e.source = 'year_close' AND e.status = 'posted'
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries r
          WHERE r.tenant_id = e.tenant_id AND r.reversal_of_id = e.id)
     ORDER BY e.date`);
  return z.array(closingEntrySchema).parse(rows);
}

// The year that `end` closes, or an error under the field when `end` is not a year's last day
function yearEndingOn(end: string, settings: YearSettings): { start: string; end: string } {
  const year = fiscalYearOf(end, settings.startMonth);
  if (year.end !== end) {
    throw new AppError(409, 'year_end_invalid', `${end} is not the last day of a fiscal year.`, {
      fieldErrors: { end: ['year_end_invalid'] },
    });
  }
  return year;
}

// The lines that empty each income and expense account into retained earnings. A debit balance
// (an expense) is closed with a credit, a credit balance (income) with a debit; the difference —
// the profit or the loss — goes to retained earnings on the side that balances the entry.
function closingLines(
  balances: readonly { accountId: string; balance: string }[],
  retainedEarningsId: string,
): LineInput[] {
  const lines: LineInput[] = balances.map((item) => ({
    accountId: item.accountId,
    branchId: null,
    description: null,
    debit: isNegativeMoney(item.balance) ? absMoney(item.balance) : '0',
    credit: isNegativeMoney(item.balance) ? '0' : item.balance,
  }));
  // Income − expenses: positive = a profit, which retained earnings takes as a credit
  const profit = naturalAmount('income', sumMoney(balances.map((item) => item.balance)));
  if (!isZeroMoney(profit)) {
    lines.push({
      accountId: retainedEarningsId,
      branchId: null,
      description: null,
      debit: isNegativeMoney(profit) ? absMoney(profit) : '0',
      credit: isNegativeMoney(profit) ? '0' : profit,
    });
  }
  return lines;
}

@Injectable()
export class FiscalYearsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly posting: PostingService,
  ) {}

  list(): Promise<FiscalYearList> {
    return this.withTenant(async (tx) => ({
      items: await this.years(tx),
      lockDate: (await readLock(tx))?.lockDate ?? null,
    }));
  }

  close(end: string): Promise<FiscalYear> {
    return this.withTenant(async (tx) => {
      // Exclusive first: nothing posts while the year closes, and the lock date moves at the end
      // of the same transaction (period-lock.service.ts explains why exclusive comes first)
      await lockBooks(tx);
      const settings = await readSettings(tx);
      const year = yearEndingOn(end, settings);
      const label = fiscalYearLabel(year.start, settings.startMonth);

      // The last day must be over: the afternoon's sales would otherwise land in a closed year
      if (end >= todayIn(settings.timezone)) {
        throw new AppError(409, 'year_not_ended', `The year ${label} has not ended yet.`);
      }
      if ((await closingEntries(tx)).some((entry) => entry.date === end)) {
        throw new AppError(409, 'year_already_closed', `The year ${label} is closed already.`);
      }
      const drafts = await this.draftsBetween(tx, year.start, year.end);
      if (drafts > 0) {
        throw new AppError(
          409,
          'year_has_drafts',
          `${String(drafts)} drafts are dated in ${label}.`,
          {
            params: { count: drafts },
          },
        );
      }
      // Years close in order. The day before this year starts, every income and expense account
      // must be empty — closed by the earlier year's closing entry, or never used.
      if ((await profitAndLossBalances(tx, shiftIsoDate(year.start, -1))).length > 0) {
        throw new AppError(409, 'year_earlier_open', 'Close the earlier fiscal year first.');
      }
      // A clear answer when the lock date already covers the year, before anything is computed
      await assertPeriodOpen(tx, end);

      const balances = await profitAndLossBalances(tx, end);
      if (balances.length === 0) {
        throw new AppError(409, 'year_nothing_to_close', `Nothing moved in ${label}.`);
      }
      const [retained] = z.array(z.object({ id: z.uuid() })).parse(
        await tx.execute(
          sql`SELECT id::text FROM ledger_accounts
                 WHERE tenant_id = ${getTenantId()}::uuid AND purpose = 'retained_earnings'`,
        ),
      );
      // Every template has it, and a purpose account cannot be deleted or archived (step 9)
      if (!retained) throw new Error('The chart has no retained earnings account');

      const entry = await this.posting.postNew(tx, {
        date: end,
        narration: `Year-end close ${label}`,
        source: 'year_close',
        lines: closingLines(balances, retained.id),
      });
      // The whole year is closed now; the lock date was before `end` (assertPeriodOpen above)
      await writeLockDate(tx, await readLock(tx), end);
      await audit(tx, {
        action: 'books.year_closed',
        entityType: 'workspace',
        entityId: getTenantId(),
        changes: created({ year: label, entry: entry.number }),
      });
      return this.year(tx, end);
    });
  }

  reopen(end: string): Promise<FiscalYear> {
    return this.withTenant(async (tx) => {
      await lockBooks(tx);
      const settings = await readSettings(tx);
      const year = yearEndingOn(end, settings);
      const label = fiscalYearLabel(year.start, settings.startMonth);
      const closings = await closingEntries(tx);
      const closing = closings.find((entry) => entry.date === end);
      if (!closing) throw new AppError(409, 'year_not_closed', `The year ${label} is not closed.`);
      // Years reopen backwards: a later year's closing entry already counts this year's profit in
      // retained earnings, so reopening only this one would count it twice
      if (closings.some((entry) => entry.date > end)) {
        throw new AppError(409, 'year_later_closed', 'Reopen the later fiscal year first.');
      }

      // Open the books from the year's first day; the years before it stay closed
      const lock = await readLock(tx);
      if (lock && lock.lockDate !== null && lock.lockDate >= year.start) {
        await writeLockDate(tx, lock, shiftIsoDate(year.start, -1));
      }
      // The reversal is dated on the closing entry's own day, so the year's income and expenses
      // are back exactly where they were, and nothing spills into the next year
      const lines = await tx.execute(sql`
        SELECT account_id::text, branch_id::text, description, debit::text, credit::text
          FROM journal_lines
         WHERE tenant_id = ${getTenantId()}::uuid AND entry_id = ${closing.id}::uuid
         ORDER BY line_no`);
      const reversed = await this.posting.postNew(tx, {
        date: end,
        narration: `Reversal of ${closing.number}`,
        source: 'reversal',
        reversalOfId: closing.id,
        lines: z
          .array(
            z.object({
              account_id: z.uuid(),
              branch_id: z.uuid().nullable(),
              description: z.string().nullable(),
              debit: z.string(),
              credit: z.string(),
            }),
          )
          .parse(lines)
          .map((line) => ({
            accountId: line.account_id,
            branchId: line.branch_id,
            description: line.description,
            debit: line.credit,
            credit: line.debit,
          })),
      });
      await audit(tx, {
        action: 'books.year_reopened',
        entityType: 'workspace',
        entityId: getTenantId(),
        changes: created({ year: label, reversal: reversed.number }),
      });
      return this.year(tx, end);
    });
  }

  private async draftsBetween(tx: Transaction, start: string, end: string): Promise<number> {
    const [row] = z.array(z.object({ count: z.number().int() })).parse(
      await tx.execute(sql`
          SELECT count(*)::int AS count FROM journal_entries
           WHERE tenant_id = ${getTenantId()}::uuid AND status = 'draft'
             AND date BETWEEN ${start}::date AND ${end}::date`),
    );
    return row?.count ?? 0;
  }

  // Newest first, from the current fiscal year (or a later one, if an entry is dated there) back
  // to the year of the oldest entry. A draft counts: an old draft blocks its year's close, so its
  // year must be on the list.
  private async years(tx: Transaction): Promise<FiscalYear[]> {
    const settings = await readSettings(tx);
    const current = fiscalYearOf(todayIn(settings.timezone), settings.startMonth);
    const [range] = z
      .array(z.object({ oldest: z.iso.date().nullable(), newest: z.iso.date().nullable() }))
      .parse(
        await tx.execute(
          sql`SELECT min(date)::text AS oldest, max(date)::text AS newest
                FROM journal_entries WHERE tenant_id = ${getTenantId()}::uuid`,
        ),
      );
    const yearOf = (date: string | null | undefined) =>
      date ? fiscalYearOf(date, settings.startMonth) : current;
    const first = yearOf(range?.oldest);
    const last = yearOf(range?.newest);
    const closings = await closingEntries(tx);
    const profit = await dailyProfit(tx);
    const drafts = new Map(
      z
        .array(z.object({ date: z.iso.date(), count: z.number().int() }))
        .parse(
          await tx.execute(sql`
            SELECT date::text AS date, count(*)::int AS count FROM journal_entries
             WHERE tenant_id = ${getTenantId()}::uuid AND status = 'draft' GROUP BY date`),
        )
        .map((row) => [row.date, row.count]),
    );

    const items: FiscalYear[] = [];
    let start = last.start > current.start ? last.start : current.start;
    const stop = first.start < current.start ? first.start : current.start;
    for (;;) {
      const year = fiscalYearOf(start, settings.startMonth);
      const inYear = (date: string) => date >= year.start && date <= year.end;
      const closing = closings.find((entry) => entry.date === year.end);
      items.push({
        start: year.start,
        end: year.end,
        label: fiscalYearLabel(year.start, settings.startMonth),
        status: closing ? 'closed' : 'open',
        closingEntry: closing ? { id: closing.id, number: closing.number } : null,
        netProfit: sumMoney([...profit].filter(([date]) => inYear(date)).map(([, net]) => net)),
        drafts: [...drafts].filter(([date]) => inYear(date)).reduce((sum, [, n]) => sum + n, 0),
      });
      if (year.start <= stop) break;
      start = shiftIsoDate(year.start, -1);
    }
    return items;
  }

  private async year(tx: Transaction, end: string): Promise<FiscalYear> {
    const found = (await this.years(tx)).find((item) => item.end === end);
    if (!found) throw new Error(`Fiscal year ending ${end} not in the list`);
    return found;
  }
}
