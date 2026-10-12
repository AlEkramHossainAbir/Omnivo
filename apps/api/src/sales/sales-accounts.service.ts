import { Inject, Injectable } from '@nestjs/common';
import { type SalesAccounts, type UpdateSalesAccountsInput } from '@omnivo/contracts';
import { ledgerAccounts, tenantSettings } from '@omnivo/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { lockChart } from '../accounts/accounts.service.js';
import { audit, diff } from '../common/audit/audit.js';
import { AppError } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// The account credit notes take sales back from (step 15d, you chose a setting), as Settings →
// Sales shows and saves it. It lives on the workspace's settings row, but has its own route: PUT
// /settings is the company's details, and needs no account rules.
@Injectable()
export class SalesAccountsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  get(): Promise<SalesAccounts> {
    return this.withTenant((tx) => this.read(tx));
  }

  // An active income ledger, or none (the Sales account itself). Like the stock accounts: a group
  // posts nothing, and an expense or an asset would put the sales that came back in the wrong part
  // of the profit and loss.
  update(input: UpdateSalesAccountsInput): Promise<SalesAccounts> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      // The chart's own lock: nobody archives or deletes this account until we commit
      // (AccountsService takes it first, then refuses the account this setting points at)
      await lockChart(tx);
      const before = await this.read(tx);
      if (input.returns !== null) {
        const [account] = await tx
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.tenantId, tenantId),
              eq(ledgerAccounts.id, input.returns),
              eq(ledgerAccounts.type, 'income'),
              eq(ledgerAccounts.isGroup, false),
              isNull(ledgerAccounts.archivedAt),
            ),
          );
        if (!account) {
          throw new AppError(409, 'sales_account_invalid', 'Pick an active income account.', {
            fieldErrors: { returns: ['sales_account_invalid'] },
          });
        }
      }
      // No new version: the settings form's version guards the company's details, which this
      // does not touch (the logo works the same way)
      await tx
        .update(tenantSettings)
        .set({ salesReturnsAccountId: input.returns, updatedBy: currentPrincipal().userId })
        .where(eq(tenantSettings.tenantId, tenantId));
      const after = await this.read(tx);
      // The audit log shows codes ("4120"), which a person can read, not ids
      const codeOf = await this.codes(tx, [before.returns, after.returns]);
      await audit(tx, {
        action: 'sales_accounts.changed',
        entityType: 'workspace',
        entityId: tenantId,
        changes: diff(
          { returns: before.returns === null ? null : (codeOf.get(before.returns) ?? null) },
          { returns: after.returns === null ? null : (codeOf.get(after.returns) ?? null) },
        ),
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

  private async read(tx: Transaction): Promise<SalesAccounts> {
    const [settings] = await tx
      .select({ returns: tenantSettings.salesReturnsAccountId })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    if (!settings) throw new Error(`tenant_settings row missing for tenant ${getTenantId()}`);
    return settings;
  }
}
