import {
  POS_SALES_ON_DEVICE_DAYS,
  type PosReturnableSale,
  shiftIsoDate,
  sumQuantity,
  todayIn,
} from '@omnivo/contracts';
import type { posSales } from '@omnivo/db';
import { posReturnLines, posSaleLines, posSalePayments, tenantSettings } from '@omnivo/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { customerRefs, toSalesLine, withVariants } from '../sales/sales-lines.js';

type SaleRow = typeof posSales.$inferSelect;

// The first day of the sales a device keeps (decision 21): POS_SALES_ON_DEVICE_DAYS before the
// workspace's today. The device drops older rows by its own clock; a day either way at the edge
// only means a row kept a day longer or sent a day less.
export async function posSalesFrom(tx: Transaction): Promise<string> {
  const tenantId = getTenantId();
  const [settings] = await tx
    .select({ timezone: tenantSettings.timezone })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, tenantId));
  if (!settings) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);
  return shiftIsoDate(todayIn(settings.timezone), -POS_SALES_ON_DEVICE_DAYS);
}

// What the posted returns brought back of each sale line so far: the quantity in the line's unit,
// and the serial numbers, in the order they came back
export interface Returned {
  quantity: string;
  serialNumbers: string[];
}

const NOTHING_RETURNED: Returned = { quantity: '0.0000', serialNumbers: [] };

// Summed in TypeScript, not with SQL's sum(): a line has a handful of returns at most, and the
// quantity comes back in the 4 decimals every quantity of the API has. pos_return_lines_returned_idx
// finds the rows by sale line.
export async function returnedOf(
  tx: Transaction,
  saleLineIds: readonly string[],
): Promise<Map<string, Returned>> {
  if (saleLineIds.length === 0) return new Map();
  const rows = await tx
    .select({
      saleLineId: posReturnLines.saleLineId,
      quantity: posReturnLines.quantity,
      serialNumbers: posReturnLines.serialNumbers,
    })
    .from(posReturnLines)
    .where(
      and(
        eq(posReturnLines.tenantId, getTenantId()),
        inArray(posReturnLines.saleLineId, [...saleLineIds]),
      ),
    )
    .orderBy(asc(posReturnLines.id));
  const returned = new Map<string, Returned>();
  for (const row of rows) {
    const before = returned.get(row.saleLineId) ?? NOTHING_RETURNED;
    returned.set(row.saleLineId, {
      quantity: sumQuantity([before.quantity, row.quantity]),
      serialNumbers: [...before.serialNumbers, ...row.serialNumbers],
    });
  }
  return returned;
}

export function returnedFor(returned: Map<string, Returned>, saleLineId: string): Returned {
  return returned.get(saleLineId) ?? NOTHING_RETURNED;
}

// The sales a return reads (decision 22): the route's answer by receipt number, the register's
// recent sales and the device's pos_sale rows are all this one shape, so the return screen reads
// any of them the same way. In the order of `sales`; the caller picked and sorted them.
export async function returnableSalesOf(
  tx: Transaction,
  sales: readonly SaleRow[],
): Promise<PosReturnableSale[]> {
  if (sales.length === 0) return [];
  const tenantId = getTenantId();
  const saleIds = sales.map((sale) => sale.id);
  const lineRows = await tx
    .select()
    .from(posSaleLines)
    .where(and(eq(posSaleLines.tenantId, tenantId), inArray(posSaleLines.saleId, saleIds)))
    .orderBy(asc(posSaleLines.saleId), asc(posSaleLines.lineNo));
  const lines = await withVariants(tx, lineRows);
  const returned = await returnedOf(
    tx,
    lineRows.map((row) => row.id),
  );
  const payments = await tx
    .select({
      saleId: posSalePayments.saleId,
      method: posSalePayments.method,
      amount: posSalePayments.amount,
    })
    .from(posSalePayments)
    .where(and(eq(posSalePayments.tenantId, tenantId), inArray(posSalePayments.saleId, saleIds)))
    .orderBy(asc(posSalePayments.saleId), asc(posSalePayments.lineNo));
  const customers = await customerRefs(
    tx,
    sales.flatMap((sale) => (sale.customerId === null ? [] : [sale.customerId])),
  );

  return sales.map((sale) => ({
    id: sale.id,
    number: sale.number,
    registerId: sale.registerId,
    date: sale.date,
    soldAt: sale.soldAt.toISOString(),
    customer: sale.customerId === null ? null : (customers.get(sale.customerId) ?? null),
    pricesIncludeVat: sale.pricesIncludeVat,
    total: sale.total,
    lines: lines
      .filter(({ row }) => row.saleId === sale.id)
      .map(({ row, variant }) => {
        const line = toSalesLine(row, variant);
        const back = returnedFor(returned, row.id);
        return {
          variantId: line.variantId,
          productId: line.productId,
          productCode: line.productCode,
          productName: line.productName,
          optionValues: line.optionValues,
          sku: line.sku,
          baseUnitId: line.baseUnitId,
          id: row.id,
          tracking: variant.tracking,
          unitId: row.unitId,
          quantity: row.quantity,
          baseQuantity: row.baseQuantity,
          description: row.description,
          unitPrice: row.unitPrice,
          taxRate: line.taxRate,
          net: row.net,
          vat: row.vat,
          total: row.total,
          serialNumbers: row.serialNumbers,
          returnedSerialNumbers: back.serialNumbers,
          returnedQuantity: back.quantity,
        };
      }),
    payments: payments
      .filter((payment) => payment.saleId === sale.id)
      .map((payment) => ({ method: payment.method, amount: payment.amount })),
  }));
}
