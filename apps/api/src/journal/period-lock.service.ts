import { Inject, Injectable } from '@nestjs/common';
import { type PeriodLock, type PeriodLockInput, todayIn } from '@omnivo/contracts';
import { periodLocks, tenantSettings } from '@omnivo/db';
import { eq, sql } from 'drizzle-orm';

import { audit, diff } from '../common/audit/audit.js';
import { AppError, versionConflict } from '../common/http/app-error.js';
import { getTenantId, tenantStorage } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// One advisory lock number per tenant for "the lock date". Every posting takes it SHARED: postings
// never wait for each other. Changing the lock date takes it EXCLUSIVE: it waits until the
// postings in flight commit, and new postings wait until the new date is committed. Without it, a
// posting could read the old date, and commit an entry into a month that was closed meanwhile.
// No row lock instead: the row exists only after the first change (version 0 = no row).
function lockKey(): string {
  return `period_lock:${getTenantId()}`;
}

export async function readLock(tx: Transaction) {
  const [row] = await tx
    .select({ lockDate: periodLocks.lockDate, version: periodLocks.version })
    .from(periodLocks)
    .where(eq(periodLocks.tenantId, getTenantId()));
  return row;
}

// The exclusive side of the lock above: the lock date's own page, and the year-end close and
// reopen (step 11), which post an entry and move the lock date in one transaction. Taking it
// exclusive first matters there: a transaction that already holds the shared lock and then asks
// for the exclusive one would wait for every other posting, and two of them would deadlock.
export async function lockBooks(tx: Transaction): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey()}, 0))`);
}

// Writes the lock date and logs it. The caller holds lockBooks(), so the insert cannot race.
export async function writeLockDate(
  tx: Transaction,
  before: { lockDate: string | null; version: number } | undefined,
  lockDate: string | null,
): Promise<PeriodLock> {
  const tenantId = getTenantId();
  const userId = tenantStorage.getStore()?.principal?.userId ?? null;
  const [row] = before
    ? await tx
        .update(periodLocks)
        .set({ lockDate, version: sql`${periodLocks.version} + 1`, updatedBy: userId })
        .where(eq(periodLocks.tenantId, tenantId))
        .returning({ lockDate: periodLocks.lockDate, version: periodLocks.version })
    : await tx
        .insert(periodLocks)
        .values({ tenantId, lockDate, updatedBy: userId })
        .returning({ lockDate: periodLocks.lockDate, version: periodLocks.version });
  if (!row) throw new Error('Period lock write returned no row');
  await audit(tx, {
    action: 'books.lock_date_changed',
    entityType: 'workspace',
    entityId: tenantId,
    changes: diff({ lockDate: before?.lockDate ?? null }, { lockDate: row.lockDate }),
  });
  return row;
}

// For every posting and reversal (PostingService). Dates are ISO strings, so `<=` on them is the
// order of the days.
export async function assertPeriodOpen(tx: Transaction, date: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${lockKey()}, 0))`);
  const lockDate = (await readLock(tx))?.lockDate ?? null;
  if (lockDate !== null && date <= lockDate) {
    throw new AppError(409, 'journal_period_locked', `The books are closed up to ${lockDate}.`, {
      fieldErrors: { date: ['journal_period_locked'] },
    });
  }
}

@Injectable()
export class PeriodLockService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  get(): Promise<PeriodLock> {
    return this.withTenant(async (tx) => {
      const row = await readLock(tx);
      return { lockDate: row?.lockDate ?? null, version: row?.version ?? 0 };
    });
  }

  update(input: PeriodLockInput): Promise<PeriodLock> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      await lockBooks(tx);
      const before = await readLock(tx);
      if ((before?.version ?? 0) !== input.version) throw versionConflict();

      // Closing a day that has not ended would refuse today's sales in the afternoon. "Today" is
      // the company's, not the server's: 1 am in Dhaka is still yesterday in UTC.
      if (input.lockDate !== null) {
        const [settings] = await tx
          .select({ timezone: tenantSettings.timezone })
          .from(tenantSettings)
          .where(eq(tenantSettings.tenantId, tenantId));
        if (!settings) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);
        if (input.lockDate > todayIn(settings.timezone)) {
          throw new AppError(409, 'period_lock_future', 'The lock date cannot be in the future.', {
            fieldErrors: { lockDate: ['period_lock_future'] },
          });
        }
      }

      return writeLockDate(tx, before, input.lockDate);
    });
  }
}
