import { z } from 'zod';

import { customFieldValuesSchema } from './custom-fields.js';
import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { priceSchema } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import type { Industry } from './setup.js';
import { factorSchema } from './units.js';

// goods = kept in stock (from step 13); service = sold, never stocked (stitching charge, delivery)
export const PRODUCT_TYPES = ['goods', 'service'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

// How each unit of stock is told apart (build plan 0.3): not at all (a T-shirt), by batch or lot
// (a medicine, with its expiry), or one by one (a phone, by IMEI). Set per product; the batch and
// serial screens come with the stock steps.
export const TRACKING_MODES = ['none', 'batch', 'serial'] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

export function isTrackingMode(value: string): value is TrackingMode {
  return TRACKING_MODES.some((mode) => mode === value);
}

// What a new product's form starts with, by business type: a pharma company tracks every product
// by batch with an expiry date; the others start untracked and switch per product (a retailer's
// milk has an expiry, its T-shirts do not)
export function trackingDefault(industry: Industry | null): {
  tracking: TrackingMode;
  hasExpiry: boolean;
} {
  return industry === 'pharma'
    ? { tracking: 'batch', hasExpiry: true }
    : { tracking: 'none', hasExpiry: false };
}

// Up to three options (Size, Colour, Fit) like most shops and ERPs; 300 variants is a garments
// style in 12 sizes and 25 colours, with room to spare
export const MAX_PRODUCT_OPTIONS = 3;
export const MAX_OPTION_VALUES = 50;
export const MAX_VARIANTS = 300;
export const MAX_PRODUCT_UNITS = 10;

// ---------------------------------------------------------------------------------------------
// Codes and barcodes

// Letters of any script and digits, then dots, slashes, underscores or hyphens: P-00042,
// ST-2026/118, NAPA-500. No spaces: a code is typed into a scanner field and searched for whole.
const CODE = /^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u;

function optionalCode(code: 'product_code_format' | 'product_sku_format') {
  return z
    .string()
    .trim()
    .max(40, errorCode(code))
    .refine((value) => value === '' || CODE.test(value), errorCode(code))
    .transform((value) => (value === '' ? null : value))
    .nullable();
}

// A variant's SKU when the person leaves it empty: the product's code for a simple product,
// the code and the option values for a variant — ST-118 + [M, Navy blue] → ST-118-M-NAVY-BLUE.
// Anything a code may not hold (spaces, &) becomes a hyphen.
export function variantSku(productCode: string, optionValues: readonly string[]): string {
  const parts = optionValues.map((value) =>
    value
      .toUpperCase()
      .replace(/[^\p{L}\p{N}._/]+/gu, '-')
      .replace(/^-+|-+$/g, ''),
  );
  return [productCode, ...parts.filter((part) => part !== '')].join('-').slice(0, 40);
}

// GS1's check digit (EAN-8, UPC-A, EAN-13): from the right, the digits are weighted 3, 1, 3, …;
// the check digit makes the sum a multiple of 10. A typo in one digit always breaks it.
export function hasValidCheckDigit(digits: string): boolean {
  let sum = 0;
  for (let index = digits.length - 2, weight = 3; index >= 0; index -= 1, weight = 4 - weight) {
    sum += Number(digits[index]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

// What a scanner types: printable ASCII without spaces (Code 128 can hold all of it). 8, 12 or 13
// digits is a retail barcode (EAN-8, UPC-A, EAN-13) and must pass its check digit — a typed barcode
// with one wrong digit is refused here instead of never matching at the till.
const BARCODE = /^[\x21-\x7E]{1,48}$/;
const GTIN = /^(?:\d{8}|\d{12}|\d{13})$/;

export const barcodeSchema = z
  .string()
  .trim()
  .refine((value) => value === '' || BARCODE.test(value), errorCode('barcode_format'))
  .refine(
    (value) => !GTIN.test(value) || hasValidCheckDigit(value),
    errorCode('barcode_check_digit'),
  )
  .transform((value) => (value === '' ? null : value))
  .nullable();

// ---------------------------------------------------------------------------------------------
// What the API sends

export const productOptionSchema = z.object({
  name: z.string(),
  // In the order the person typed them: S, M, L, XL — not alphabetical
  values: z.array(z.string()),
});
export type ProductOption = z.infer<typeof productOptionSchema>;

// The thing that is stocked and sold. A simple product has exactly one, with no option values;
// stock, sales and purchase lines (steps 13–17) always point at a variant.
export const productVariantSchema = z.object({
  id: z.uuid(),
  sku: z.string(),
  // One value per option, in the options' order: ['M', 'Navy blue']
  optionValues: z.array(z.string()),
  // The barcode of one base unit
  barcode: z.string().nullable(),
  // Per base unit, a decimal string like every amount; null = no fixed price
  salePrice: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
});
export type ProductVariant = z.infer<typeof productVariantSchema>;

// A bigger unit the product also comes in: a box of 10 strips, a carton of 24, a 50 kg sack
export const productUnitSchema = z.object({
  unitId: z.uuid(),
  // How many base units one of these is, as a decimal string: "24", "0.914400"
  factor: z.string(),
  // The pack's own barcode (a carton's ITF or EAN). Only on products without variants.
  barcode: z.string().nullable(),
});
export type ProductUnit = z.infer<typeof productUnitSchema>;

export const productSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  // z.string(), not enums: a newer server's new type or tracking mode must not break an older
  // offline client (the rule of error codes and account purposes)
  type: z.string(),
  categoryId: z.uuid().nullable(),
  description: z.string().nullable(),
  // Stock is always counted in this unit
  baseUnitId: z.uuid(),
  // The unit sales and purchase forms start with; null = the base unit
  salesUnitId: z.uuid().nullable(),
  purchaseUnitId: z.uuid().nullable(),
  tracking: z.string(),
  // Batches carry an expiry date (medicine, food)
  hasExpiry: z.boolean(),
  // Empty = a simple product
  options: z.array(productOptionSchema),
  variants: z.array(productVariantSchema),
  units: z.array(productUnitSchema),
  // Every saved value, the archived fields' too (the form shows only the active ones)
  customFields: customFieldValuesSchema,
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Product = z.infer<typeof productSchema>;

// One row of the list: no variants, units or custom fields — a page of 50 stays small
export const productSummarySchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  type: z.string(),
  categoryId: z.uuid().nullable(),
  baseUnitId: z.uuid(),
  tracking: z.string(),
  hasVariants: z.boolean(),
  // Active variants only
  variantCount: z.number().int(),
  // The lowest and highest sale price of the active variants; null when none has a price
  minPrice: z.string().nullable(),
  maxPrice: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type ProductSummary = z.infer<typeof productSummarySchema>;

// ---------------------------------------------------------------------------------------------
// What a form or an import sends

// The form's "None" options send '' for "not chosen"
const optionalIdSchema = z
  .union([z.uuid(), z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable();

const optionValueSchema = z.string().trim().min(1).max(40);

const productOptionInputSchema = z.object({
  name: z.string().trim().min(1, errorCode('product_option_name_required')).max(30),
  values: z
    .array(optionValueSchema)
    .min(1, errorCode('product_option_values_required'))
    .max(MAX_OPTION_VALUES),
});

const productVariantInputSchema = z.object({
  // An existing variant keeps its id (its stock and history from step 13 hang on it); null = new
  id: z.uuid().nullable(),
  // null = made from the product's code (variantSku)
  sku: optionalCode('product_sku_format'),
  optionValues: z.array(optionValueSchema).max(MAX_PRODUCT_OPTIONS),
  barcode: barcodeSchema,
  salePrice: priceSchema,
  // A colour that is no longer made: hidden from new sales, kept for the history
  archived: z.boolean(),
});
export type ProductVariantInput = z.input<typeof productVariantInputSchema>;

const productUnitInputSchema = z.object({
  unitId: z.uuid(errorCode('product_unit_required')),
  factor: factorSchema,
  barcode: barcodeSchema,
});

// The fields without the cross-field rules below: the product form extends it with the
// workspace's own custom fields, then adds the same rules (productRules) on top
export const productFieldsSchema = z.object({
  // null = the next number from the 'inventory.product' series (P-00042)
  code: optionalCode('product_code_format'),
  name: z.string().trim().min(2, errorCode('product_name_required')).max(120),
  type: z.enum(PRODUCT_TYPES),
  categoryId: optionalIdSchema,
  description: optionalText(500),
  baseUnitId: z.uuid(errorCode('product_unit_required')),
  // null or '' = the base unit
  salesUnitId: optionalIdSchema,
  purchaseUnitId: optionalIdSchema,
  tracking: z.enum(TRACKING_MODES),
  hasExpiry: z.boolean(),
  options: z.array(productOptionInputSchema).max(MAX_PRODUCT_OPTIONS),
  variants: z.array(productVariantInputSchema).min(1).max(MAX_VARIANTS),
  units: z.array(productUnitInputSchema).max(MAX_PRODUCT_UNITS),
  customFields: customFieldValuesSchema,
});

type ProductRuleInput = Omit<z.output<typeof productFieldsSchema>, 'customFields'>;

// The rules between fields. Each error sits on the field the person has to change, so the form
// shows it in the right place — and the import maps the same paths to its CSV columns.
export function productRules(input: ProductRuleInput, ctx: z.RefinementCtx<ProductRuleInput>) {
  const issue = (path: (string | number)[], code: Parameters<typeof errorCode>[0]) => {
    ctx.addIssue({ code: 'custom', path, message: errorCode(code) });
  };

  // Options: each name once, each value once inside its option (case does not make a new one)
  const optionNames = new Set<string>();
  input.options.forEach((option, index) => {
    const name = option.name.toLowerCase();
    if (optionNames.has(name)) issue(['options', index, 'name'], 'product_option_twice');
    optionNames.add(name);
    const values = new Set<string>();
    option.values.forEach((value, valueIndex) => {
      if (values.has(value.toLowerCase())) {
        issue(['options', index, 'values', valueIndex], 'product_option_value_twice');
      }
      values.add(value.toLowerCase());
    });
  });

  // Variants: a simple product has one, without values; otherwise every variant has one value of
  // each option, and no two variants the same values
  if (input.options.length === 0) {
    if (input.variants.length !== 1 || input.variants[0]?.optionValues.length !== 0) {
      issue(['variants'], 'product_variants_simple');
    }
  } else {
    const combinations = new Set<string>();
    input.variants.forEach((variant, index) => {
      const fits =
        variant.optionValues.length === input.options.length &&
        variant.optionValues.every((value, k) => input.options[k]?.values.includes(value));
      if (!fits) issue(['variants', index, 'optionValues'], 'product_variant_values');
      const key = JSON.stringify(variant.optionValues);
      if (combinations.has(key))
        issue(['variants', index, 'optionValues'], 'product_variant_twice');
      combinations.add(key);
    });
  }
  if (input.variants.every((variant) => variant.archived)) {
    issue(['variants'], 'product_variant_last_active');
  }

  // Units: each once, never the base unit itself, and the default units are among them
  const unitIds = new Set<string>();
  input.units.forEach((unit, index) => {
    if (unit.unitId === input.baseUnitId) issue(['units', index, 'unitId'], 'product_unit_is_base');
    else if (unitIds.has(unit.unitId)) issue(['units', index, 'unitId'], 'product_unit_twice');
    unitIds.add(unit.unitId);
    if (input.options.length > 0 && unit.barcode !== null) {
      issue(['units', index, 'barcode'], 'product_pack_barcode_variants');
    }
  });
  for (const field of ['salesUnitId', 'purchaseUnitId'] as const) {
    const unitId = input[field];
    if (unitId !== null && unitId !== input.baseUnitId && !unitIds.has(unitId)) {
      issue([field], 'product_default_unit_invalid');
    }
  }

  // Tracking: a service is never stocked; an expiry belongs to a batch
  if (input.type === 'service' && input.tracking !== 'none') {
    issue(['tracking'], 'product_tracking_service');
  }
  if (input.hasExpiry && input.tracking !== 'batch')
    issue(['hasExpiry'], 'product_expiry_needs_batch');

  // A barcode or a SKU means one thing: checked across the whole form here, and across the
  // workspace by the database's unique indexes
  const barcodes = new Set<string>();
  const seeBarcode = (barcode: string | null, path: (string | number)[]) => {
    if (barcode === null) return;
    if (barcodes.has(barcode)) issue(path, 'barcode_twice');
    barcodes.add(barcode);
  };
  const skus = new Set<string>();
  input.variants.forEach((variant, index) => {
    seeBarcode(variant.barcode, ['variants', index, 'barcode']);
    if (variant.sku === null) return;
    if (skus.has(variant.sku.toLowerCase())) issue(['variants', index, 'sku'], 'product_sku_twice');
    skus.add(variant.sku.toLowerCase());
  });
  input.units.forEach((unit, index) => {
    seeBarcode(unit.barcode, ['units', index, 'barcode']);
  });
}

export const productInputSchema = productFieldsSchema.superRefine(productRules);
export type ProductInput = z.infer<typeof productInputSchema>;
export type ProductFormValues = z.input<typeof productInputSchema>;

export const updateProductInputSchema = productFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(productRules);
export type UpdateProductInput = z.infer<typeof updateProductInputSchema>;

export const productVersionInputSchema = z.object({ version: versionSchema });

export const deleteProductQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// ---------------------------------------------------------------------------------------------
// The list

export const PRODUCT_SORTS = ['name', '-name', 'code', '-code', '-updated'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export const PRODUCT_STATUSES = ['active', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const productListQuerySchema = pageQuerySchema.extend({
  // Part of the name, the code or a SKU, or a whole barcode (a scan into the search box)
  search: z.string().trim().max(100).optional(),
  // This category and every category under it
  categoryId: z.uuid().optional(),
  status: z.enum(PRODUCT_STATUSES).default('active'),
  sort: z.enum(PRODUCT_SORTS).default('name'),
});
export type ProductListQuery = z.input<typeof productListQuerySchema>;

export const productPageSchema = pageOf(productSummarySchema);
export type ProductPage = z.infer<typeof productPageSchema>;

const productParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like the chart of accounts: every sales, purchase and stock line
// picks a product. A product holds no cost (step 14's valuation does), so the list shows no margin.
export const productRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/products',
    summary: 'Products, a page at a time, searched, filtered and sorted on the server',
    auth: 'bearer',
    status: 200,
    query: productListQuerySchema,
    response: productPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/products/:id',
    summary: 'One product with its variants, units and custom fields',
    auth: 'bearer',
    status: 200,
    params: productParamsSchema,
    response: productSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/products',
    summary: 'Add a product with its variants and units',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 201,
    body: productInputSchema,
    response: productSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/products/:id',
    summary: 'Change a product: the variants and units sent replace the ones it had',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: productParamsSchema,
    body: updateProductInputSchema,
    response: productSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/products/:id/archive',
    summary: 'Hide a product from new documents; its history stays',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: productParamsSchema,
    body: productVersionInputSchema,
    response: productSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/products/:id/restore',
    summary: 'Bring an archived product back',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: productParamsSchema,
    body: productVersionInputSchema,
    response: productSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/products/:id',
    summary: 'Delete a product that no document uses yet',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 204,
    params: productParamsSchema,
    query: deleteProductQuerySchema,
    response: z.void(),
  }),
};
