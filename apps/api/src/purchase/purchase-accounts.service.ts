import { Inject, Injectable } from '@nestjs/common';
import type { PurchaseAccounts, UpdatePurchaseAccountsInput } from '@omnivo/contracts';
import { ledgerAccounts, tenantSettings } from '@omnivo/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { lockChart } from '../accounts/accounts.service.js';
import { audit, diff } from '../common/audit/audit.js';
import { AppError } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

// The two accounts a bill posts to besides the payable, VAT input and goods received not billed
// (step 17c, decision 17), as Settings → Purchase shows and saves them. Like SalesAccountsService:
// on the workspace's settings row, with a route of its own.
@Injectable()
export class PurchaseAccountsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  get(): Promise<PurchaseAccounts> {
    return this.withTenant((tx) => readPurchaseAccounts(tx));
  }

  // Each one an active expense ledger, or none. An expense, because both sit in the profit and loss
  // next to what the goods cost: a price difference is part of the cost of what was bought, and a
  // dyeing charge is a cost too. A group posts nothing.
  update(input: UpdatePurchaseAccountsInput): Promise<PurchaseAccounts> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      // The chart's own lock: nobody archives or deletes these accounts until we commit
      // (AccountsService takes it first, then refuses an account this setting points at)
      await lockChart(tx);
      const before = await readPurchaseAccounts(tx);
      const chosen = [
        ['priceDifference', input.priceDifference],
        ['services', input.services],
      ] as const;
      const ids = chosen.flatMap(([, id]) => (id === null ? [] : [id]));
      const usable =
        ids.length === 0
          ? []
          : await tx
              .select({ id: ledgerAccounts.id })
              .from(ledgerAccounts)
              .where(
                and(
                  eq(ledgerAccounts.tenantId, tenantId),
                  inArray(ledgerAccounts.id, ids),
                  eq(ledgerAccounts.type, 'expense'),
                  eq(ledgerAccounts.isGroup, false),
                  isNull(ledgerAccounts.archivedAt),
                ),
              );
      const known = new Set(usable.map((row) => row.id));
      const invalid = chosen.flatMap(([field, id]) =>
        id === null || known.has(id) ? [] : [field],
      );
      if (invalid.length > 0) {
        throw new AppError(409, 'purchase_account_invalid', 'Pick an active expense account.', {
          fieldErrors: Object.fromEntries(
            invalid.map((field) => [field, ['purchase_account_invalid']]),
          ),
        });
      }
      // No new version: the settings form's version guards the company's details, which this
      // does not touch (like the sales returns account)
      await tx
        .update(tenantSettings)
        .set({
          purchasePriceDifferenceAccountId: input.priceDifference,
          purchaseServicesAccountId: input.services,
          updatedBy: currentPrincipal().userId,
        })
        .where(eq(tenantSettings.tenantId, tenantId));
      const after = await readPurchaseAccounts(tx);
      // The audit log shows codes ("5180"), which a person can read, not ids
      const codeOf = await this.codes(tx, [...Object.values(before), ...Object.values(after)]);
      const codes = (accounts: PurchaseAccounts) => ({
        priceDifference:
          accounts.priceDifference === null ? null : (codeOf.get(accounts.priceDifference) ?? null),
        services: accounts.services === null ? null : (codeOf.get(accounts.services) ?? null),
      });
      await audit(tx, {
        action: 'purchase_accounts.changed',
        entityType: 'workspace',
        entityId: tenantId,
        changes: diff(codes(before), codes(after)),
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
}

// The two choices as they are now. BillsService reads the services account with it, to start a
// service line that names none.
export async function readPurchaseAccounts(tx: Transaction): Promise<PurchaseAccounts> {
  const [settings] = await tx
    .select({
      priceDifference: tenantSettings.purchasePriceDifferenceAccountId,
      services: tenantSettings.purchaseServicesAccountId,
    })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, getTenantId()));
  if (!settings) throw new Error(`tenant_settings row missing for tenant ${getTenantId()}`);
  return settings;
}
