import { z } from 'zod';

import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';

// What a unit measures. Units of one dimension convert into each other by a fixed ratio (a kg is
// 1000 g everywhere); units of different dimensions never do on their own.
export const UNIT_DIMENSIONS = ['count', 'weight', 'length', 'area', 'volume'] as const;
export type UnitDimension = (typeof UNIT_DIMENSIONS)[number];

// A ratio or a conversion factor: a positive decimal string with at most 6 places, the way
// Postgres sends NUMERIC(19,6) ("0.914400"). A yard is 0.9144 m; a pack of 6 is "6".
const FACTOR = /^\d{1,13}(?:\.\d{1,6})?$/;
const MICRO = 1_000_000n;

// "0.9144" → 914400n: millionths, as BigInt, so the arithmetic is exact (like money.ts, and for
// the same reason: contracts may use zod and nothing else, so no decimal.js here)
function toMicro(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0'));
}

function fromMicro(micro: bigint): string {
  return `${String(micro / MICRO)}.${String(micro % MICRO).padStart(6, '0')}`;
}

export function isFactor(value: string): boolean {
  return FACTOR.test(value) && toMicro(value) > 0n;
}

// Two factors are the same number however they are written: "12" and "12.000000"
export function sameFactor(a: string, b: string): boolean {
  return toMicro(a) === toMicro(b);
}

// A form sends a factor as typed: "24", "0.5". Zero is not a factor: a pack of nothing.
export const factorSchema = z
  .string()
  .trim()
  .refine((value) => isFactor(value), errorCode('factor_format'));

// How many base units one `unit` is, when both have a fixed ratio in the same dimension: with a
// metre base, a yard is 0.9144; with a yard base, a metre is 1.093613 (rounded half up to the 6
// places the column keeps). null when there is no standard answer — a box holds as many tablets as
// that product's box holds, so the person types it.
export function standardFactor(
  unit: Pick<Unit, 'dimension' | 'ratio'>,
  base: Pick<Unit, 'dimension' | 'ratio'>,
): string | null {
  if (unit.ratio === null || base.ratio === null || unit.dimension !== base.dimension) return null;
  const numerator = toMicro(unit.ratio) * MICRO;
  const denominator = toMicro(base.ratio);
  return fromMicro((numerator * 2n + denominator) / (denominator * 2n));
}

export const unitSchema = z.object({
  id: z.uuid(),
  // What lists and forms show: "pcs", "kg", "box"
  code: z.string(),
  name: z.string(),
  // z.string(), not an enum: a newer server's new dimension must not break an older offline client
  dimension: z.string(),
  // How many of the dimension's reference unit (pcs, kg, m, m², l) one of this unit is. null = a
  // pack (box, carton, strip): its size differs from product to product.
  ratio: z.string().nullable(),
  // How many decimals a quantity in this unit may have: 0 for pieces, 3 for kg (1.250 kg of
  // rice). The stock and sales steps round quantities to it.
  decimals: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Unit = z.infer<typeof unitSchema>;

export function isUnitDimension(value: string): value is UnitDimension {
  return UNIT_DIMENSIONS.some((dimension) => dimension === value);
}

// Letters of any script and digits, then dots, slashes or hyphens: pcs, kg, m², sq.ft, পিস
const unitCodeSchema = z
  .string()
  .trim()
  .min(1, errorCode('unit_code_format'))
  .max(12, errorCode('unit_code_format'))
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}²³._/-]*$/u, errorCode('unit_code_format'));

const unitNameSchema = z.string().trim().min(1, errorCode('unit_name_required')).max(40);

export const createUnitInputSchema = z.object({
  code: unitCodeSchema,
  name: unitNameSchema,
  dimension: z.enum(UNIT_DIMENSIONS),
  // '' = a pack. Fixed once made: changing it would change what every product's quantity means.
  ratio: z
    .string()
    .trim()
    .refine((value) => value === '' || isFactor(value), errorCode('factor_format'))
    .transform((value) => (value === '' ? null : value))
    .nullable(),
  decimals: z.number().int().min(0).max(4),
});
export type CreateUnitInput = z.infer<typeof createUnitInputSchema>;

// The dimension and the ratio stay as they were made
export const updateUnitInputSchema = z.object({
  code: unitCodeSchema,
  name: unitNameSchema,
  decimals: z.number().int().min(0).max(4),
  version: versionSchema,
});
export type UpdateUnitInput = z.infer<typeof updateUnitInputSchema>;

export const unitVersionInputSchema = z.object({ version: versionSchema });

export const deleteUnitQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// A workspace has a few dozen units at most: the whole list at once, archived ones included
export const unitListSchema = z.object({ items: z.array(unitSchema) });

const unitParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission: every product form, and from step 13 every stock and sales line,
// picks a unit from this list
export const unitRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/units',
    summary: 'The units of measure of the workspace, archived ones included',
    auth: 'bearer',
    status: 200,
    response: unitListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/units',
    summary: 'Add a unit of measure',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 201,
    body: createUnitInputSchema,
    response: unitSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/units/:id',
    summary: "Change a unit's code, name or decimals",
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: unitParamsSchema,
    body: updateUnitInputSchema,
    response: unitSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/units/:id/archive',
    summary: 'Hide a unit from new products; products that use it keep it',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: unitParamsSchema,
    body: unitVersionInputSchema,
    response: unitSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/units/:id/restore',
    summary: 'Bring an archived unit back',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 200,
    params: unitParamsSchema,
    body: unitVersionInputSchema,
    response: unitSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/units/:id',
    summary: 'Delete a unit that no product uses',
    auth: 'bearer',
    permission: 'inventory.product.manage',
    status: 204,
    params: unitParamsSchema,
    query: deleteUnitQuerySchema,
    response: z.void(),
  }),
};
