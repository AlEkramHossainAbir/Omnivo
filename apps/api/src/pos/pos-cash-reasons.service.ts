import { Inject, Injectable } from '@nestjs/common';
import {
  isPartyAccountPurpose,
  type PosCashReason,
  type PosCashReasonInput,
  type UpdatePosCashReasonInput,
} from '@omnivo/contracts';
import { ledgerAccounts, posCashReasons } from '@omnivo/db';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { stockAccountIds } from '../journal/posting.service.js';

export type PosCashReasonRow = typeof posCashReasons.$inferSelect;

// As the API and the devices (the pull's pos_cash_reason rows) show it
export function toPosCashReason(row: PosCashReasonRow): PosCashReason {
  return {
    id: row.id,
    name: row.name,
    direction: row.direction,
    accountId: row.accountId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function nameTaken(): AppError {
  return new AppError(409, 'pos_reason_name_taken', 'Another reason has this name.', {
    fieldErrors: { name: ['pos_reason_name_taken'] },
  });
}

function accountInvalid(): AppError {
  return new AppError(
    409,
    'pos_reason_account_invalid',
    'Pick an active account that is not a group, a customer or supplier account, or the stock.',
    { fieldErrors: { accountId: ['pos_reason_account_invalid'] } },
  );
}

// Pay in and pay out reasons (step 20b, decision 4): Settings → POS, with pos.register.manage.
// Every device of the workspace keeps the active ones (decision 20), so a cashier picks one
// offline. A reason is never deleted (0054 takes DELETE away): old movements point at it.
@Injectable()
export class PosCashReasonsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  // In and out apart, then by name, as the settings page and the cashier's select show them
  list(query: { status: 'active' | 'archived' }): Promise<PosCashReason[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(posCashReasons)
        .where(
          and(
            eq(posCashReasons.tenantId, getTenantId()),
            query.status === 'active'
              ? isNull(posCashReasons.archivedAt)
              : isNotNull(posCashReasons.archivedAt),
          ),
        )
        .orderBy(asc(posCashReasons.direction), sql`lower(${posCashReasons.name})`);
      return rows.map(toPosCashReason);
    });
  }

  async create(input: PosCashReasonInput): Promise<PosCashReason> {
    try {
      return await this.withTenant(async (tx) => {
        await this.checkAccount(tx, input.accountId);
        const [row] = await tx
          .insert(posCashReasons)
          .values({
            tenantId: getTenantId(),
            name: input.name,
            direction: input.direction,
            accountId: input.accountId,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('POS cash reason insert returned no row');
        await audit(tx, {
          action: 'pos_cash_reason.created',
          entityType: 'pos_cash_reason',
          entityId: row.id,
          changes: created(await this.snapshot(tx, row)),
        });
        return toPosCashReason(row);
      });
    } catch (error) {
      // The one rule the check before cannot see: two creates with one name at the same moment
      if (isUniqueViolation(error, 'pos_cash_reasons_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  // The name and the account; the direction never changes (decision 20). A movement keeps the
  // account it was posted to, so a new account moves no old money.
  async update(id: string, input: UpdatePosCashReasonInput): Promise<PosCashReason> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        // An archived reason keeps an account archived since; only a new choice must be usable
        if (input.accountId !== before.accountId) await this.checkAccount(tx, input.accountId);
        const [after] = await tx
          .update(posCashReasons)
          .set({
            name: input.name,
            accountId: input.accountId,
            version: sql`${posCashReasons.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(posCashReasons.tenantId, getTenantId()), eq(posCashReasons.id, id)))
          .returning();
        if (!after) throw notFound('POS cash reason');
        await audit(tx, {
          action: 'pos_cash_reason.updated',
          entityType: 'pos_cash_reason',
          entityId: id,
          changes: diff(await this.snapshot(tx, before), await this.snapshot(tx, after)),
        });
        return toPosCashReason(after);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'pos_cash_reasons_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  // An archived reason leaves the devices with their next pull. One a device chose before that
  // still posts when its movement arrives (decision 40).
  setArchived(id: string, version: number, archived: boolean): Promise<PosCashReason> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) === archived) return toPosCashReason(before);
      // Its account may have been archived meanwhile: a reason comes back with a usable one
      if (!archived) await this.checkAccount(tx, before.accountId);
      const [after] = await tx
        .update(posCashReasons)
        .set({
          archivedAt: archived ? new Date() : null,
          version: sql`${posCashReasons.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(posCashReasons.tenantId, getTenantId()), eq(posCashReasons.id, id)))
        .returning();
      if (!after) throw notFound('POS cash reason');
      await audit(tx, {
        action: archived ? 'pos_cash_reason.archived' : 'pos_cash_reason.restored',
        entityType: 'pos_cash_reason',
        entityId: id,
      });
      return toPosCashReason(after);
    });
  }

  private async lock(tx: Transaction, id: string): Promise<PosCashReasonRow> {
    const [row] = await tx
      .select()
      .from(posCashReasons)
      .where(and(eq(posCashReasons.tenantId, getTenantId()), eq(posCashReasons.id, id)))
      .for('update');
    if (!row) throw notFound('POS cash reason');
    return row;
  }

  // The account a reason's money comes from or goes to: an active account of this workspace that
  // is not a group, not one kept per party (a pay out names no customer or supplier, so its line
  // would break the party rule) and not a stock account (a pay out moves no stock). Any type: a
  // bank or a safe (an asset), tea for the staff (an expense), a loan from the owner (a liability).
  // FOR SHARE: nobody archives it before we commit. One answer for every reason it is not usable,
  // like the journal's accounts.
  private async checkAccount(tx: Transaction, id: string): Promise<void> {
    const [account] = await tx
      .select({
        isGroup: ledgerAccounts.isGroup,
        purpose: ledgerAccounts.purpose,
        archivedAt: ledgerAccounts.archivedAt,
      })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, id)))
      .for('share');
    if (
      !account ||
      account.isGroup ||
      account.archivedAt !== null ||
      isPartyAccountPurpose(account.purpose) ||
      (await stockAccountIds(tx)).has(id)
    ) {
      throw accountInvalid();
    }
  }

  // What the audit log shows: the account by its code, so a reader sees "1121" and not an id
  private async snapshot(tx: Transaction, row: PosCashReasonRow) {
    const [account] = await tx
      .select({ code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, row.accountId)));
    return { name: row.name, direction: row.direction, account: account?.code ?? null };
  }
}
