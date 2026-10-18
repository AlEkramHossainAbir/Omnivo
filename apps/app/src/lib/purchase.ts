import {
  type ApprovalRound,
  type ApprovalStep,
  defaultLineDescription,
  draftRequisitionLineAmount,
  plainQuantity,
  type Product,
  type ProductVariant,
  type RequisitionLine,
  type RequisitionLineFormValues,
  sumMoney,
  type VariantRef,
  waitingStep,
} from '@omnivo/contracts';

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
