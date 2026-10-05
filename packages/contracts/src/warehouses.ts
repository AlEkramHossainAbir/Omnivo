import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';

// A place that holds stock: a fabric store and a finished goods store in one factory, a depot, a
// shop's back room. It belongs to a branch, so stock can be read branch by branch (and, from step
// 14, valued that way). Archived, never deleted: its movements stay in every stock card.
export const warehouseSchema = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  code: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type Warehouse = z.infer<typeof warehouseSchema>;

// Short and upper case like a branch code (MAIN, FAB, FG, CTG-DEPOT is too long): it sits in
// narrow table columns and on a transfer slip. Upper-cased first, so "fab" and "FAB" are one code.
const warehouseCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,10}$/, errorCode('warehouse_code_format'));

export const warehouseInputSchema = z.object({
  // The form's empty select sends '' — "not chosen", with its own message
  branchId: z.uuid(errorCode('warehouse_branch_invalid')),
  code: warehouseCodeSchema,
  name: z.string().trim().min(2, errorCode('warehouse_name_required')).max(120),
  address: optionalText(300),
});
export type WarehouseInput = z.infer<typeof warehouseInputSchema>;

export const updateWarehouseInputSchema = warehouseInputSchema.extend({ version: versionSchema });
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseInputSchema>;

export const warehouseVersionInputSchema = z.object({ version: versionSchema });

export const WAREHOUSE_STATUSES = ['active', 'archived'] as const;
export type WarehouseStatus = (typeof WAREHOUSE_STATUSES)[number];

export const warehouseListQuerySchema = z.object({
  status: z.enum(WAREHOUSE_STATUSES).default('active'),
});

// A company has a handful of warehouses, a distributor a few dozen: the whole list at once
export const warehouseListSchema = z.object({ items: z.array(warehouseSchema) });

const warehouseParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission: every stock page and every stock line picks a warehouse
export const warehouseRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/warehouses',
    summary: 'The warehouses of the workspace',
    auth: 'bearer',
    status: 200,
    query: warehouseListQuerySchema,
    response: warehouseListSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/warehouses',
    summary: 'Add a warehouse to a branch',
    auth: 'bearer',
    permission: 'inventory.warehouse.manage',
    status: 201,
    body: warehouseInputSchema,
    response: warehouseSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/warehouses/:id',
    summary: "Change a warehouse's code, name, address or branch",
    auth: 'bearer',
    permission: 'inventory.warehouse.manage',
    status: 200,
    params: warehouseParamsSchema,
    body: updateWarehouseInputSchema,
    response: warehouseSchema,
  }),
  archive: defineRoute({
    method: 'POST',
    path: '/warehouses/:id/archive',
    summary: 'Archive an empty warehouse',
    auth: 'bearer',
    permission: 'inventory.warehouse.manage',
    status: 200,
    params: warehouseParamsSchema,
    body: warehouseVersionInputSchema,
    response: warehouseSchema,
  }),
  restore: defineRoute({
    method: 'POST',
    path: '/warehouses/:id/restore',
    summary: 'Bring an archived warehouse back',
    auth: 'bearer',
    permission: 'inventory.warehouse.manage',
    status: 200,
    params: warehouseParamsSchema,
    body: warehouseVersionInputSchema,
    response: warehouseSchema,
  }),
};
