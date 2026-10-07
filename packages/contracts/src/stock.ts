import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText } from './fields.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { levelSchema, quantitySchema } from './quantities.js';

// What a movement is, by the document that made it. The response sends it as z.string(), like a
// journal source: a newer server's new kind (a sales delivery, step 15) must not break an older
// offline client.
// revaluation (step 14): a change of value without a change of quantity — its quantity is zero.
// delivery (step 15b): goods leaving for a customer on a delivery challan.
export const MOVEMENT_KINDS = [
  'adjustment',
  'transfer_out',
  'transfer_in',
  'revaluation',
  'delivery',
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export function isMovementKind(value: string): value is MovementKind {
  return MOVEMENT_KINDS.some((kind) => kind === value);
}

// An opening stock sheet or a transfer of a whole depot runs to a few hundred lines; a line of
// phones to a few hundred serial numbers
export const MAX_STOCK_LINES = 500;
export const MAX_SERIALS_PER_LINE = 1000;

// ---------------------------------------------------------------------------------------------
// What a document line sends

// What a scanner types: an IMEI (15 digits), a machine's plate (SN-4471-B). Printable ASCII
// without spaces, like a barcode, and matched exactly as typed.
export const serialNumberSchema = z
  .string()
  .trim()
  .regex(/^[\x21-\x7E]{1,64}$/, errorCode('serial_number_format'));

// The form's "not chosen" is '' (the sales documents of step 15b use these two as well)
export const optionalIdSchema = z
  .union([z.uuid(), z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable();

export const optionalDateSchema = z
  .union([z.iso.date(), z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable();

// One line that takes stock out (or moves it): which variant, in which unit, how many. A batch
// product names the batch it takes from (FEFO picks it in the form); a serial product lists the
// serial numbers, one per base unit.
export const stockLineFieldsSchema = z.object({
  variantId: z.uuid(errorCode('stock_variant_required')),
  // The base unit or one of the product's packs; the quantity is in this unit
  unitId: z.uuid(errorCode('stock_unit_invalid')),
  quantity: quantitySchema,
  batchId: optionalIdSchema,
  serialNumbers: z.array(serialNumberSchema).max(MAX_SERIALS_PER_LINE),
});

// A line that brings stock in (an adjustment "in", opening stock) also says which batch the goods
// are: the lot number printed on them, and its dates. Receiving more of an existing lot adds to
// that batch.
export const stockInLineFieldsSchema = stockLineFieldsSchema.extend({
  lotNumber: optionalText(40),
  expiresOn: optionalDateSchema,
  manufacturedOn: optionalDateSchema,
});

interface LineFields {
  serialNumbers: readonly string[];
  manufacturedOn?: string | null;
  expiresOn?: string | null;
}

// The rules inside one line: each serial number once, and a batch that expires after it was made.
// Each error sits on the field to change, so the form shows it there.
export function stockLineRules<T extends LineFields>(line: T, ctx: z.RefinementCtx<T>): void {
  const seen = new Set<string>();
  line.serialNumbers.forEach((serial, index) => {
    if (seen.has(serial)) {
      ctx.addIssue({
        code: 'custom',
        path: ['serialNumbers', index],
        message: errorCode('stock_serial_twice'),
      });
    }
    seen.add(serial);
  });
  const made = line.manufacturedOn ?? null;
  const expires = line.expiresOn ?? null;
  if (made !== null && expires !== null && expires <= made) {
    ctx.addIssue({ code: 'custom', path: ['expiresOn'], message: errorCode('stock_batch_dates') });
  }
}

// A serial number moves once per document: the same IMEI on two lines is a scanning slip
export function documentSerialRules<T extends { lines: readonly LineFields[] }>(
  input: T,
  ctx: z.RefinementCtx<T>,
): void {
  const seen = new Set<string>();
  input.lines.forEach((line, lineIndex) => {
    line.serialNumbers.forEach((serial, index) => {
      if (seen.has(serial)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', lineIndex, 'serialNumbers', index],
          message: errorCode('stock_serial_twice'),
        });
      }
      seen.add(serial);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// What the API sends

// Which variant a row is about, with what a person needs to recognise it
export const variantRefSchema = z.object({
  variantId: z.uuid(),
  productId: z.uuid(),
  productCode: z.string(),
  productName: z.string(),
  // Empty for a simple product
  optionValues: z.array(z.string()),
  sku: z.string(),
  baseUnitId: z.uuid(),
});
export type VariantRef = z.infer<typeof variantRefSchema>;

// A pack of the product, for the line's unit select: "1 carton = 24 pcs"
export const stockUnitSchema = z.object({ unitId: z.uuid(), factor: z.string() });

// One variant on the stock page and in the "Add items" search
export const stockItemSchema = variantRefSchema.extend({
  // z.string(), not the enum: the rule of products.ts
  tracking: z.string(),
  hasExpiry: z.boolean(),
  units: z.array(stockUnitSchema),
  // The product or the variant is archived: it shows while it still holds stock
  archived: z.boolean(),
  // In the chosen warehouse, or in all of them. Decimal strings with 4 places, in the base unit.
  onHand: z.string(),
  // Sent from another warehouse and not received yet (to the chosen warehouse, or anywhere)
  inTransit: z.string(),
  // Promised and not delivered yet (step 15b): what confirmed sales orders still have to deliver
  // from the chosen warehouse (or from any). Nothing is held for them; it is shown next to onHand,
  // so a salesperson sees what is already promised.
  onOrder: z.string(),
  // At or below its reorder level in the chosen warehouse (or in any warehouse)
  low: z.boolean(),
  // Step 14, only for someone with inventory.stock.value (null for everyone else, and for a
  // variant that never had a cost). unitCost: the company-wide average per base unit, 4 decimals.
  // value: what onHand is worth — in all warehouses the ledger's own total, in one warehouse its
  // quantity at the average cost.
  unitCost: z.string().nullable(),
  value: z.string().nullable(),
});
export type StockItem = z.infer<typeof stockItemSchema>;

// A line of an adjustment or a transfer as the API sends it: the variant with what the form needs
// to edit it again (its packs, its tracking), what was typed, and the quantity in the base unit
export const stockLineSchema = variantRefSchema.extend({
  id: z.uuid(),
  tracking: z.string(),
  hasExpiry: z.boolean(),
  units: z.array(stockUnitSchema),
  unitId: z.uuid(),
  quantity: z.string(),
  baseQuantity: z.string(),
  batchId: z.uuid().nullable(),
  lotNumber: z.string().nullable(),
  expiresOn: z.iso.date().nullable(),
  manufacturedOn: z.iso.date().nullable(),
  serialNumbers: z.array(z.string()),
});
export type StockLine = z.infer<typeof stockLineSchema>;

export const STOCK_FILTERS = ['all', 'in_stock', 'low'] as const;
export type StockFilter = (typeof STOCK_FILTERS)[number];

export const stockListQuerySchema = pageQuerySchema.extend({
  // Part of the name, the code or a SKU; or a whole barcode or serial number (a scan)
  search: z.string().trim().max(100).optional(),
  warehouseId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  filter: z.enum(STOCK_FILTERS).default('all'),
});
export type StockListQuery = z.input<typeof stockListQuerySchema>;

export const stockPageSchema = pageOf(stockItemSchema);
export type StockPage = z.infer<typeof stockPageSchema>;

// One variant's stock card: where it is, in which batches, which serial numbers
export const stockCardSchema = z.object({
  item: stockItemSchema,
  // Every active warehouse, and an archived one that still holds some
  warehouses: z.array(
    z.object({
      warehouseId: z.uuid(),
      onHand: z.string(),
      inTransit: z.string(),
      minQuantity: z.string().nullable(),
      reorderQuantity: z.string().nullable(),
    }),
  ),
  // The batches with stock, the one to use first (FEFO: first expiry, first out) on top
  batches: z.array(
    z.object({
      batchId: z.uuid(),
      lotNumber: z.string(),
      manufacturedOn: z.iso.date().nullable(),
      expiresOn: z.iso.date().nullable(),
      warehouseId: z.uuid(),
      quantity: z.string(),
    }),
  ),
  // The serial numbers in stock, and the ones on their way (warehouseId null = in transit)
  serials: z.array(z.object({ serialNumber: z.string(), warehouseId: z.uuid().nullable() })),
});
export type StockCard = z.infer<typeof stockCardSchema>;

// One row of the stock card's history. quantity is signed: + in, − out. balance runs over the
// rows of the chosen warehouse (or all of them), in date order.
export const stockMovementSchema = z.object({
  id: z.uuid(),
  date: z.iso.date(),
  warehouseId: z.uuid(),
  kind: z.string(),
  documentId: z.uuid(),
  documentNumber: z.string(),
  quantity: z.string(),
  balance: z.string(),
  // Signed like quantity; null without inventory.stock.value (step 14)
  value: z.string().nullable(),
  lotNumber: z.string().nullable(),
  serialNumber: z.string().nullable(),
});
export type StockMovement = z.infer<typeof stockMovementSchema>;

export const stockMovementQuerySchema = pageQuerySchema.extend({
  warehouseId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export const stockMovementPageSchema = pageOf(stockMovementSchema).extend({
  // Before `from`, and after `to` — the same on every page
  openingBalance: z.string(),
  closingBalance: z.string(),
});
export type StockMovementPage = z.infer<typeof stockMovementPageSchema>;

// The expiry report: every batch with stock, the soonest expiry first
export const batchStockSchema = variantRefSchema.extend({
  batchId: z.uuid(),
  lotNumber: z.string(),
  manufacturedOn: z.iso.date().nullable(),
  expiresOn: z.iso.date().nullable(),
  warehouseId: z.uuid(),
  quantity: z.string(),
});
export type BatchStock = z.infer<typeof batchStockSchema>;

export const batchStockQuerySchema = pageQuerySchema.extend({
  warehouseId: z.uuid().optional(),
  // Only batches that expire within this many days of today (expired ones always show)
  expiresWithin: z.coerce.number<number>().int().min(0).max(3650).optional(),
});

export const batchStockPageSchema = pageOf(batchStockSchema);
export type BatchStockPage = z.infer<typeof batchStockPageSchema>;

// The reorder report: a variant in a warehouse at or below its reorder level
export const reorderItemSchema = variantRefSchema.extend({
  warehouseId: z.uuid(),
  onHand: z.string(),
  inTransit: z.string(),
  minQuantity: z.string(),
  reorderQuantity: z.string().nullable(),
});
export type ReorderItem = z.infer<typeof reorderItemSchema>;

export const reorderListQuerySchema = pageQuerySchema.extend({ warehouseId: z.uuid().optional() });

export const reorderPageSchema = pageOf(reorderItemSchema);
export type ReorderPage = z.infer<typeof reorderPageSchema>;

// Reorder when the stock in this warehouse falls to minQuantity; order reorderQuantity. Both empty
// = no level. An order size without a level means nothing to anyone.
export const reorderLevelInputSchema = z
  .object({
    warehouseId: z.uuid(),
    variantId: z.uuid(),
    minQuantity: levelSchema,
    reorderQuantity: levelSchema,
  })
  .superRefine((input, ctx) => {
    if (input.reorderQuantity === null) return;
    if (input.minQuantity === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['minQuantity'],
        message: errorCode('reorder_level_required'),
      });
    }
    if (/^0+(?:\.0+)?$/.test(input.reorderQuantity)) {
      ctx.addIssue({
        code: 'custom',
        path: ['reorderQuantity'],
        message: errorCode('quantity_format'),
      });
    }
  });
export type ReorderLevelInput = z.infer<typeof reorderLevelInputSchema>;

export const reorderLevelSchema = z.object({
  warehouseId: z.uuid(),
  variantId: z.uuid(),
  minQuantity: z.string().nullable(),
  reorderQuantity: z.string().nullable(),
});

const variantParamsSchema = z.object({ id: z.uuid() });

// ---------------------------------------------------------------------------------------------
// The valuation report (step 14): what the stock is worth, per variant, and whether the books agree

export const stockValueSchema = variantRefSchema.extend({
  // In every warehouse, without what is on a truck
  quantity: z.string(),
  unitCost: z.string().nullable(),
  value: z.string(),
});
export type StockValue = z.infer<typeof stockValueSchema>;

export const stockValueQuerySchema = pageQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  categoryId: z.uuid().optional(),
});

export const stockValuePageSchema = pageOf(stockValueSchema);
export type StockValuePage = z.infer<typeof stockValuePageSchema>;

// Stock value + in transit = inventory account + goods in transit account. Every stock document
// posts both halves in one transaction, so the two sides are equal; the page shows it.
export const valuationSummarySchema = z.object({
  // In the warehouses (the sum of every variant's value)
  stockValue: z.string(),
  // Sent and not received yet
  inTransitValue: z.string(),
  // The balances of the two accounts in the books, today (null = no such account chosen yet)
  inventoryAccount: z.object({ id: z.uuid(), balance: z.string() }).nullable(),
  inTransitAccount: z.object({ id: z.uuid(), balance: z.string() }).nullable(),
  // stock + in transit − both accounts: "0.0000" when the books agree
  difference: z.string(),
});
export type ValuationSummary = z.infer<typeof valuationSummarySchema>;

// Reading stock needs no permission: a sales officer checks it before promising a delivery, a
// cashier before a sale. What it costs needs inventory.stock.value (step 14): without it, every
// cost and value in these answers is null, and the valuation report is refused.
export const stockRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/stock',
    summary: 'Stock on hand per variant, in one warehouse or all of them',
    auth: 'bearer',
    status: 200,
    query: stockListQuerySchema,
    response: stockPageSchema,
  }),
  card: defineRoute({
    method: 'GET',
    path: '/stock/variants/:id',
    summary: "One variant's stock per warehouse, batch and serial number",
    auth: 'bearer',
    status: 200,
    params: variantParamsSchema,
    response: stockCardSchema,
  }),
  movements: defineRoute({
    method: 'GET',
    path: '/stock/variants/:id/movements',
    summary: "One variant's stock movements in date order, with the running balance",
    auth: 'bearer',
    status: 200,
    params: variantParamsSchema,
    query: stockMovementQuerySchema,
    response: stockMovementPageSchema,
  }),
  batches: defineRoute({
    method: 'GET',
    path: '/stock/batches',
    summary: 'Batches with stock, the soonest expiry first',
    auth: 'bearer',
    status: 200,
    query: batchStockQuerySchema,
    response: batchStockPageSchema,
  }),
  reorder: defineRoute({
    method: 'GET',
    path: '/stock/reorder',
    summary: 'Variants at or below their reorder level',
    auth: 'bearer',
    status: 200,
    query: reorderListQuerySchema,
    response: reorderPageSchema,
  }),
  valuation: defineRoute({
    method: 'GET',
    path: '/stock/valuation',
    summary: 'What the stock is worth, per variant, at the average cost',
    auth: 'bearer',
    permission: 'inventory.stock.value',
    status: 200,
    query: stockValueQuerySchema,
    response: stockValuePageSchema,
  }),
  valuationSummary: defineRoute({
    method: 'GET',
    path: '/stock/valuation/summary',
    summary: 'The total stock value, and whether the books agree with it',
    auth: 'bearer',
    permission: 'inventory.stock.value',
    status: 200,
    response: valuationSummarySchema,
  }),
  setReorderLevel: defineRoute({
    method: 'PUT',
    path: '/stock/reorder-levels',
    summary: "Set or clear a variant's reorder level in a warehouse",
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    body: reorderLevelInputSchema,
    response: reorderLevelSchema,
  }),
};
