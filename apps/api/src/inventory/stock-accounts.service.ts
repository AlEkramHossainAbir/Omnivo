import { Inject, Injectable } from '@nestjs/common';
import {
  accountTypeFits,
  type ErrorCode,
  STOCK_ACCOUNT_USES,
  type StockAccounts,
  type UpdateStockAccountsInput,
} from '@omnivo/contracts';
import { ledgerAccounts, stockAccounts } from '@omnivo/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { lockChart } from '../accounts/accounts.service.js';
import { audit, diff } from '../common/audit/audit.js';
import { AppError } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// The accounts stock documents post to (step 14), as Settings → Inventory shows and saves them
@Injectable()
export class StockAccountsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  get(): Promise<StockAccounts> {
    return this.withTenant((tx) => this.read(tx));
  }

  // Every use at once, like the settings form: each must be an active ledger of a type that fits
  // (an asset for goods in transit, income or expense for the rest), and never the inventory
  // account itself — stock against stock would post nothing real.
  update(input: UpdateStockAccountsInput): Promise<StockAccounts> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      // The chart's own lock: nobody archives or deletes one of these accounts until we commit
      // (AccountsService takes it first, then refuses an account a stock use points at)
      await lockChart(tx);
      const before = await this.read(tx);
      const ids = [...new Set(STOCK_ACCOUNT_USES.map((use) => input[use]))];
      const accounts = await tx
        .select({
          id: ledgerAccounts.id,
          code: ledgerAccounts.code,
          type: ledgerAccounts.type,
          isGroup: ledgerAccounts.isGroup,
          purpose: ledgerAccounts.purpose,
        })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.tenantId, tenantId),
            inArray(ledgerAccounts.id, ids),
            isNull(ledgerAccounts.archivedAt),
          ),
        );
      const byId = new Map(accounts.map((account) => [account.id, account]));
      const fieldErrors: Record<string, ErrorCode[]> = {};
      for (const use of STOCK_ACCOUNT_USES) {
        const account = byId.get(input[use]);
        if (account?.purpose === 'inventory') fieldErrors[use] = ['stock_account_inventory'];
        else if (!account || account.isGroup || !accountTypeFits(use, account.type)) {
          fieldErrors[use] = ['stock_account_invalid'];
        }
      }
      const [first] = Object.values(fieldErrors);
      if (first?.[0] !== undefined) {
        throw new AppError(409, first[0], 'Some stock accounts cannot be used.', { fieldErrors });
      }

      await tx
        .insert(stockAccounts)
        .values(
          STOCK_ACCOUNT_USES.map((use) => ({
            tenantId,
            use,
            accountId: input[use],
            updatedBy: currentPrincipal().userId,
          })),
        )
        .onConflictDoUpdate({
          target: [stockAccounts.tenantId, stockAccounts.use],
          set: {
            // The row's new value, as this insert would have written it
            accountId: sql`excluded.account_id`,
            updatedAt: new Date(),
            updatedBy: currentPrincipal().userId,
          },
        });
      const after = await this.read(tx);
      // The audit log shows codes ("5150"), which a person can read, not ids
      const codeOf = await this.codes(tx, [...Object.values(before), ...ids]);
      const asCodes = (choices: StockAccounts) =>
        Object.fromEntries(
          STOCK_ACCOUNT_USES.map((use) => {
            const id = choices[use];
            return [use, id === null ? null : (codeOf.get(id) ?? null)];
          }),
        );
      await audit(tx, {
        action: 'stock_accounts.changed',
        entityType: 'workspace',
        entityId: tenantId,
        changes: diff(asCodes(before), asCodes(after)),
      });
      return after;
    });
  }

  private async codes(
    tx: Transaction,
    ids: readonly (string | null)[],
  ): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return new Map();
    const rows = await tx
      .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), inArray(ledgerAccounts.id, wanted)));
    return new Map(rows.map((row) => [row.id, row.code]));
  }

  private async read(tx: Transaction): Promise<StockAccounts> {
    const rows = await tx
      .select({ use: stockAccounts.use, accountId: stockAccounts.accountId })
      .from(stockAccounts)
      .where(eq(stockAccounts.tenantId, getTenantId()));
    const byUse = new Map(rows.map((row) => [row.use, row.accountId]));
    return {
      in_transit: byUse.get('in_transit') ?? null,
      found: byUse.get('found') ?? null,
      damaged: byUse.get('damaged') ?? null,
      expired: byUse.get('expired') ?? null,
      lost: byUse.get('lost') ?? null,
      sample: byUse.get('sample') ?? null,
      internal_use: byUse.get('internal_use') ?? null,
      correction: byUse.get('correction') ?? null,
      transfer_shortage: byUse.get('transfer_shortage') ?? null,
      revaluation: byUse.get('revaluation') ?? null,
    };
  }
}
