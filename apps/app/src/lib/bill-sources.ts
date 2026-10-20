import type { BillLineFormValues, GoodsReceipt, PurchaseOrder } from '@omnivo/contracts';
import type { QueryClient } from '@tanstack/react-query';

import {
  type BillLineOrigin,
  itemOfReceiptLine,
  orderServiceToBill,
  receiptLinesLeft,
  receiptLineToBill,
  receiptOrderValue,
  servicesLeft,
} from './bills';
import { purchaseOrderQuery } from './queries';
import { type LineMeta, salesItemOf } from './sales';

// The lines a bill gets from a goods receipt or an order (step 17c), with what the editor and the
// form keep beside each: its meta, and where it came from. Shared by the bill form's pickers and
// by "Make bill" on a goods receipt or an order, which starts the form with them. The invoice's
// invoice-sources.ts, with a goods receipt for the challan.

export interface BillSourcedLine {
  line: BillLineFormValues;
  meta: LineMeta;
  // The goods receipt line's or the order line's id, and what the form says about it
  origin: readonly [string, BillLineOrigin];
}

let lastKey = 0;
function sourceKey(): string {
  lastKey += 1;
  return `bill-source-${String(lastKey)}`;
}

// The receipt's lines not billed yet and not on the form (`onForm`), at its order's prices (read
// through the query cache: a second receipt of the same order asks nothing again). A receipt made
// by a bill has no order, but it is billed by that bill, so it never has a line left here.
export async function receiptBillLines(
  queryClient: QueryClient,
  tenantId: string,
  receipt: GoodsReceipt,
  onForm: ReadonlySet<string>,
): Promise<{ lines: BillSourcedLine[]; order: PurchaseOrder | null }> {
  const left = receiptLinesLeft(receipt.lines, onForm);
  const order =
    receipt.order === null
      ? null
      : await queryClient.query(purchaseOrderQuery(tenantId, receipt.order.id));
  const orderLines = new Map(order?.lines.map((line) => [line.id, line]));
  return {
    order,
    lines: left.map((line) => {
      const orderLine = line.orderLineId === null ? undefined : orderLines.get(line.orderLineId);
      return {
        line: receiptLineToBill(line, orderLine),
        meta: {
          key: sourceKey(),
          item: itemOfReceiptLine(line),
          // The order's price says nothing new
          source: undefined,
          pricedFor: receipt.supplier.id,
        },
        origin: [
          line.id,
          {
            receiptNumber: receipt.number,
            orderNumber: order?.number ?? null,
            pricesIncludeVat: order?.pricesIncludeVat ?? null,
            orderValue: orderLine ? receiptOrderValue(line, orderLine) : null,
            returnedQuantity: line.returnedQuantity,
          },
        ],
      };
    }),
  };
}

// An order's service lines not billed yet and not on the form, at the order's prices
export function orderServiceLines(
  order: PurchaseOrder,
  onForm: ReadonlySet<string>,
): BillSourcedLine[] {
  return servicesLeft(order.lines, onForm).map((line) => ({
    line: orderServiceToBill(line),
    meta: {
      key: sourceKey(),
      item: salesItemOf(line),
      source: undefined,
      pricedFor: order.supplier.id,
    },
    origin: [
      line.id,
      {
        receiptNumber: null,
        orderNumber: order.number,
        pricesIncludeVat: order.pricesIncludeVat,
        orderValue: null,
        returnedQuantity: '0',
      },
    ],
  }));
}
