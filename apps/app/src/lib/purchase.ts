import {
  addMoney,
  type ApprovalRound,
  type ApprovalStep,
  compareQuantity,
  defaultLineDescription,
  draftRequisitionLineAmount,
  isZeroQuantity,
  percentOfMoney,
  plainQuantity,
  type Product,
  type ProductVariant,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type PurchaseOrderLineFormValues,
  type RequisitionLine,
  type RequisitionLineFormValues,
  subtractQuantity,
  sumMoney,
  type VariantRef,
  waitingStep,
  withTolerance,
} from '@omnivo/contracts';

import { type LineMeta, SALES_LINE_FIELDS, salesItemOf, toFormLine } from './sales';

// The pure parts of the purchase pages (step 17a): no React, so they are unit-tested
// (purchase.spec.ts) and shared by the form, the editor and the view. Here, not in
// purchase-lines-editor.tsx: the form needs them at once, and the editor is a lazy chunk of its own.

// What a line needs to know about its product, beside what the form sends: its name for the cell,
// its packs for the unit select, and whether it is a service
export type PurchaseItem = VariantRef & {
  units: readonly { unitId: string; factor: string }[];
  productType: string;
};

// What the editor keeps per line, beside the form value, at the same index
export interface PurchaseLineMeta {
  // React's key: stays with the line when a line above it is removed
  key: string;
  item: PurchaseItem;
  // Where a new line's cost came from (the cost lookup): a PURCHASE_COST_SOURCES value, or null
  // when nothing was known. undefined for a saved line: nothing new to say about it.
  source: string | null | undefined;
}

// A variant of a product the picker added
export function purchaseItemOf(product: Product, variant: ProductVariant): PurchaseItem {
  return {
    variantId: variant.id,
    productId: product.id,
    productCode: product.code,
    productName: product.name,
    optionValues: variant.optionValues,
    sku: variant.sku,
    baseUnitId: product.baseUnitId,
    units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
    productType: product.type,
  };
}

// The unit a new line starts in: the product's buying unit (a cone of yarn comes in a bag of 24),
// else its base unit
export function purchaseUnitOf(product: Product): string {
  return product.purchaseUnitId ?? product.baseUnitId;
}

// The fields of a requisition line the server may name in an error ("lines.3.estimatedCost")
export const REQUISITION_LINE_FIELDS = [
  'variantId',
  'unitId',
  'quantity',
  'description',
  'estimatedCost',
] as const;

// A saved line, as the form holds it. A description that is just the product's name is shown as
// an empty box (with the name as its placeholder), so the next save keeps following the product,
// like a sales line.
export function toRequisitionFormLine(line: RequisitionLine): RequisitionLineFormValues {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: plainQuantity(line.quantity),
    description: line.description === defaultLineDescription(line) ? '' : line.description,
    estimatedCost: line.estimatedCost,
  };
}

// The form's starting lines and the editor's meta for a saved requisition
export function savedRequisitionLines(lines: readonly RequisitionLine[]): {
  values: RequisitionLineFormValues[];
  meta: PurchaseLineMeta[];
} {
  return {
    values: lines.map(toRequisitionFormLine),
    meta: lines.map((line) => ({
      key: line.id,
      item: {
        variantId: line.variantId,
        productId: line.productId,
        productCode: line.productCode,
        productName: line.productName,
        optionValues: line.optionValues,
        sku: line.sku,
        baseUnitId: line.baseUnitId,
        units: line.units,
        productType: line.productType,
      },
      source: undefined,
    })),
  };
}

// What the lines are worth while they are typed: each line's amount (null until its quantity and
// cost are complete) and the total of the complete ones. The contracts' own functions, so the form
// shows the amount the server will store, and that chooses the approval levels.
export function requisitionFormTotals(lines: readonly RequisitionLineFormValues[]): {
  amounts: (string | null)[];
  total: string;
} {
  const amounts = lines.map((line) =>
    draftRequisitionLineAmount(line.quantity, line.estimatedCost),
  );
  return {
    amounts,
    total: sumMoney(amounts.filter((amount): amount is string => amount !== null)),
  };
}

// "Round 3" for the newest of three: the API sends the rounds newest first, and a person counts
// them from the first submission
export function roundNumber(rounds: readonly ApprovalRound[], index: number): number {
  return rounds.length - index;
}

// What a step of a round shows. A step without a decision waits only while its round is pending
// and every step above it was approved; one below it is "not yet". Once a round was rejected or
// reopened, its undecided steps were never decided ("not decided"), so they must not read as
// waiting for anyone.
export const STEP_STATES = ['approved', 'rejected', 'waiting', 'notYet', 'notDecided'] as const;
export type StepState = (typeof STEP_STATES)[number];

export function stepState(round: ApprovalRound, step: ApprovalStep): StepState {
  if (step.decision !== null) return step.decision;
  if (round.status !== 'pending') return 'notDecided';
  return waitingStep(round)?.position === step.position ? 'waiting' : 'notYet';
}

// An Owner's own document is approved when it is submitted (decision 14): the API decides each
// step in the Owner's name at once. Nobody else can approve their own document, so every step
// decided by the person who submitted it means that.
export function approvedByOwnSubmit(round: ApprovalRound): boolean {
  return (
    round.steps.length > 0 &&
    round.steps.every(
      (step) => step.decision === 'approved' && step.decidedBy?.id === round.submittedBy.id,
    )
  );
}

// ---------------------------------------------------------------------------------------------
// Step 17b: what is left to order and to receive

// What is more than nothing, or nothing: a line ordered or received over its quantity has nothing
// left, never less than nothing
function atLeastZero(value: string): string {
  return compareQuantity(value, '0') > 0 ? value : '0.0000';
}

// What a requisition line still needs ordering, in the base unit (decision 16 counts what is
// ordered)
export function leftToOrder(line: RequisitionLine): string {
  return atLeastZero(subtractQuantity(line.baseQuantity, line.orderedQuantity));
}

// An approved order whose delivery date has passed: attention, not a status. Nothing changes in
// the database when the date passes; the page works it out, like a sales order's "Late". ISO dates
// compare as strings.
export function isOrderLate(
  order: { status: string; expectedDate: string | null },
  today: string,
): boolean {
  return order.status === 'approved' && order.expectedDate !== null && order.expectedDate < today;
}

// What an order line still has to bring, in the base unit. A service line (a dyeing charge) is
// never received (decision 29); what was rejected does not count as received, the supplier still
// owes it.
export function leftToReceive(line: PurchaseOrderLine): string {
  if (line.productType === 'service') return '0.0000';
  return atLeastZero(subtractQuantity(line.baseQuantity, line.receivedQuantity));
}

// The most that may still come on an order line, in the base unit, with the workspace's
// over-receipt percent (decision 22): the same withTolerance() the API checks with, less what
// posted receipts accepted
export function allowedToReceive(line: PurchaseOrderLine, percent: string): string {
  if (line.productType === 'service') return '0.0000';
  return atLeastZero(
    subtractQuantity(withTolerance(line.baseQuantity, percent), line.receivedQuantity),
  );
}

// A goods receipt line made from an order line: what it sends to the API, before the gate fills
// in the lot and what it turned back
export interface ReceiptFill {
  orderLineId: string;
  variantId: string;
  unitId: string;
  quantity: string;
}

// "Add what is left on the order": one line per goods line with something still to come, minus
// what the form already holds for it (`onForm`: accepted base quantities by order line). A line
// nothing came for yet keeps the order's unit and quantity (40 bags); a partly received one asks
// for the rest in the base unit (120 kg), because the rest is rarely whole bags. Like the sales
// order's fillFromOrder (15b).
export function receiptFill(
  lines: readonly PurchaseOrderLine[],
  onForm: ReadonlyMap<string, string>,
): ReceiptFill[] {
  return lines.flatMap((line) => {
    const already = onForm.get(line.id) ?? '0';
    const left = subtractQuantity(leftToReceive(line), already);
    if (compareQuantity(left, '0') <= 0) return [];
    const untouched = isZeroQuantity(line.receivedQuantity) && isZeroQuantity(already);
    return [
      {
        orderLineId: line.id,
        variantId: line.variantId,
        unitId: untouched ? line.unitId : line.baseUnitId,
        quantity: untouched ? plainQuantity(line.quantity) : plainQuantity(left),
      },
    ];
  });
}

// A purchase order line's starting price (decision 19). The cost lookup sends the net per unit:
// what the goods were worth before VAT, whatever the earlier order's VAT setting was. An order
// whose prices include VAT starts from the net plus its VAT at the line's rate, to the paisa, so
// the "Price with VAT" box does not quietly start a VAT short. null stays null: nothing is known,
// and the person types a price.
export function startingPrice(
  net: string | null,
  rate: string | null,
  pricesIncludeVat: boolean,
): string | null {
  if (net === null || !pricesIncludeVat || rate === null) return net;
  return addMoney(net, percentOfMoney(net, rate));
}

// The fields of a purchase order line the server may name in an error: a sales line's, and the
// requisition line it buys for ("lines.2.requisitionLineId": closed meanwhile, or twice)
export const PURCHASE_ORDER_LINE_FIELDS = [...SALES_LINE_FIELDS, 'requisitionLineId'] as const;

// A saved order's lines as the form holds them, the editor's meta, and the requisition each line
// buys for (its number, for the link under the line). The sales line's own helpers: an order line
// is a sales line (decision 6).
export function savedOrderLines(order: PurchaseOrder): {
  values: PurchaseOrderLineFormValues[];
  meta: LineMeta[];
  links: Map<string, { requisitionId: string; number: string }>;
} {
  return {
    values: order.lines.map((line) => ({
      ...toFormLine(line),
      requisitionLineId: line.requisitionLine?.id ?? '',
    })),
    meta: order.lines.map((line) => ({
      key: line.id,
      item: salesItemOf(line),
      source: undefined,
      pricedFor: order.supplier.id,
    })),
    links: new Map(
      order.lines.flatMap((line) =>
        line.requisitionLine === null
          ? []
          : [
              [
                line.requisitionLine.id,
                {
                  requisitionId: line.requisitionLine.requisitionId,
                  number: line.requisitionLine.number,
                },
              ],
            ],
      ),
    ),
  };
}
