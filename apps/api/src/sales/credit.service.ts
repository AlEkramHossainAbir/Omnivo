import { Inject, Injectable } from '@nestjs/common';
import { compareMoney, type CustomerCredit, subtractMoney, sumMoney } from '@omnivo/contracts';
import {
  journalEntries,
  journalLines,
  ledgerAccounts,
  parties,
  products,
  salesOrderLines,
  salesOrders,
} from '@omnivo/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { AppError, notFound } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';

// What a confirmed order line will still bill, to the paisa: its total × the part not invoiced
// yet. A closed order bills only what it delivered (goods) or already billed (services): the rest
// will never come. A delivered order still bills every line in full. GREATEST: a line is never
// counted below zero.
const stillToBill = sql<string>`coalesce(sum(round(
  ${salesOrderLines.total} * greatest(
    CASE WHEN ${salesOrders.status} <> 'closed' THEN ${salesOrderLines.baseQuantity}
         WHEN ${products.type} = 'goods' THEN ${salesOrderLines.deliveredQuantity}
         ELSE ${salesOrderLines.invoicedQuantity} END
    - ${salesOrderLines.invoicedQuantity}, 0) / ${salesOrderLines.baseQuantity}, 2)), 0)::text`;

// The credit limit (step 15c, you chose this): checked when an order is confirmed and when an
// invoice is posted. What counts is the customer's exposure: what they owe now (the receivable
// lines with them, the same number as their balance) plus what confirmed orders will still bill.
// The same numbers go to the form's hint (GET /customers/:id/credit), so the hint and the block
// never disagree.
@Injectable()
export class CreditService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly permissions: PermissionService,
  ) {}

  // The route needs sales.customer.balance (the PermissionGuard checks it): the numbers say what
  // the customer owes
  get(customerId: string): Promise<CustomerCredit> {
    return this.withTenant(async (tx) => {
      const [row] = await tx
        .select({ limit: parties.creditLimit })
        .from(parties)
        .where(
          and(
            eq(parties.tenantId, getTenantId()),
            eq(parties.id, customerId),
            eq(parties.isCustomer, true),
          ),
        );
      if (!row) throw notFound('Customer');
      const { balance, onOrder } = await this.parts(tx, customerId);
      const exposure = sumMoney([balance, onOrder]);
      return {
        limit: row.limit,
        balance,
        onOrder,
        exposure,
        available: row.limit === null ? null : subtractMoney(row.limit, exposure),
      };
    });
  }

  // Before an order is confirmed or an invoice posted, inside its transaction: from here until
  // the commit, no other credit check of this customer runs, so two orders confirmed at the same
  // moment cannot each fit under the limit and together go over it. An advisory lock (a lock on a
  // number, released at commit by itself, like lockChart) instead of a lock on the customer row:
  // every sales document holds that row FOR SHARE (assertCustomer), and turning a share lock into
  // an update lock is how two writers deadlock. Taken after the document's own row locks, in every
  // caller, so two callers never wait for each other in a circle.
  // Returns the exposure now, before the change, for check().
  async lock(tx: Transaction, customerId: string): Promise<string> {
    const key = `credit:${getTenantId()}:${customerId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return this.exposure(tx, customerId);
  }

  // After the change is written: the exposure again, now with this document in it. Refused only
  // when it is over the limit AND higher than before. An invoice that bills a confirmed order at
  // its price moves the amount from "on order" to "owed" and adds nothing: it was approved when
  // the order was confirmed, and is not asked again even if the limit was lowered since.
  // overrideCreditLimit: the person saw the amounts in a dialog and goes ahead; only with
  // sales.credit.override, and the audit log keeps a row of it.
  async check(
    tx: Transaction,
    input: {
      customerId: string;
      before: string;
      overrideCreditLimit: boolean;
      entityType: 'sales_order' | 'invoice';
      entityId: string;
    },
  ): Promise<void> {
    const [row] = await tx
      .select({ limit: parties.creditLimit })
      .from(parties)
      .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, input.customerId)));
    const limit = row?.limit ?? null;
    if (limit === null) return;
    const exposure = await this.exposure(tx, input.customerId);
    if (compareMoney(exposure, limit) <= 0 || compareMoney(exposure, input.before) <= 0) return;
    if (!input.overrideCreditLimit) {
      throw new AppError(
        409,
        'credit_limit_exceeded',
        `This takes the customer to ${exposure}, over the credit limit of ${limit}.`,
        { params: { limit, exposure } },
      );
    }
    const access = await this.permissions.ofCurrentUser();
    if (!access.permissions.includes('sales.credit.override')) {
      throw new AppError(
        403,
        'credit_override_forbidden',
        'Going over a credit limit needs the sales.credit.override permission.',
        { params: { permissions: 'sales.credit.override' } },
      );
    }
    // Next to the document's own "confirmed" or "posted" row: a filter on this action lists every
    // override in the workspace
    await audit(tx, {
      action: 'credit_limit.overridden',
      entityType: input.entityType,
      entityId: input.entityId,
      changes: created({ limit, exposure }),
    });
  }

  private async exposure(tx: Transaction, customerId: string): Promise<string> {
    const { balance, onOrder } = await this.parts(tx, customerId);
    return sumMoney([balance, onOrder]);
  }

  private async parts(
    tx: Transaction,
    customerId: string,
  ): Promise<{ balance: string; onOrder: string }> {
    const tenantId = getTenantId();
    // The customer's balance, as customers.service.ts works it out: the posted receivable lines
    // that name them (journal_lines_tenant_party_idx finds them)
    const [owed] = await tx
      .select({
        value: sql<string>`round(coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0), 4)::text`,
      })
      .from(journalLines)
      .innerJoin(
        journalEntries,
        and(
          eq(journalEntries.tenantId, journalLines.tenantId),
          eq(journalEntries.id, journalLines.entryId),
        ),
      )
      .innerJoin(
        ledgerAccounts,
        and(
          eq(ledgerAccounts.tenantId, journalLines.tenantId),
          eq(ledgerAccounts.id, journalLines.accountId),
        ),
      )
      .where(
        and(
          eq(journalLines.tenantId, tenantId),
          eq(journalLines.partyId, customerId),
          eq(journalEntries.status, 'posted'),
          eq(ledgerAccounts.purpose, 'accounts_receivable'),
        ),
      );
    const [ordered] = await tx
      .select({ value: stillToBill })
      .from(salesOrderLines)
      .innerJoin(
        salesOrders,
        and(
          eq(salesOrders.tenantId, salesOrderLines.tenantId),
          eq(salesOrders.id, salesOrderLines.orderId),
        ),
      )
      .innerJoin(
        products,
        and(
          eq(products.tenantId, salesOrderLines.tenantId),
          eq(products.id, salesOrderLines.productId),
        ),
      )
      .where(
        and(
          eq(salesOrderLines.tenantId, tenantId),
          eq(salesOrders.customerId, customerId),
          inArray(salesOrders.status, ['confirmed', 'delivered', 'closed']),
        ),
      );
    return {
      balance: sumMoney([owed?.value ?? '0']),
      onOrder: sumMoney([ordered?.value ?? '0']),
    };
  }
}
