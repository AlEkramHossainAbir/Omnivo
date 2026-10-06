import {
  addMoney,
  addQuantity,
  type AdjustmentLine,
  type BatchStock,
  compareQuantity,
  defaultNumberFormat,
  type ErrorCode,
  fitsDecimals,
  formatDocumentNumber,
  isAdjustmentReason,
  isQuantity,
  isWholeQuantity,
  isZeroMoney,
  isZeroQuantity,
  type MovementKind,
  multiplyMoney,
  negateMoney,
  negateQuantity,
  periodOf,
  type Product,
  type ProductVariant,
  prorateMoney,
  type ReorderItem,
  type ReorderLevelInput,
  type StockAdjustment,
  type StockAdjustmentInput,
  type StockCard,
  type StockItem,
  type StockLine,
  type StockListQuery,
  type StockMovement,
  type StockRevaluation,
  type StockRevaluationInput,
  type StockTransfer,
  type StockTransferInput,
  type StockValue,
  splitMoney,
  subtractMoney,
  subtractQuantity,
  sumMoney,
  sumQuantity,
  toBaseQuantity,
  todayIn,
  type TransferLine,
  unitCostOf,
  type ValuationSummary,
  type Warehouse,
  wholeCount,
} from '@omnivo/contracts';

import { postStockEntry } from './journal-data';
import { MockProblem } from './mock';
import type { WorkspaceData } from './workspace-data';

// The mock's stock: warehouses, the movements (the ledger), batches, serial numbers, reorder
// levels, adjustments and transfers. Balances are added up from the movements on every read —
// a few hundred rows, no need for the API's stock_balances. The rules the UI shows errors for are
// the API's (stock_insufficient, lots, serial numbers, receipts); the rest is kept simple.

interface MockMovement {
  id: string;
  date: string;
  warehouseId: string;
  productId: string;
  variantId: string;
  batchId: string | null;
  serialNumber: string | null;
  quantity: string;
  // Step 14: signed like the quantity
  value: string;
  kind: MovementKind;
  documentId: string;
  documentNumber: string;
}

// A variant's stock and value company-wide (the API's stock_values row)
interface ValueState {
  quantity: string;
  value: string;
  unitCost: string | null;
}

interface MockBatch {
  id: string;
  variantId: string;
  lotNumber: string;
  manufacturedOn: string | null;
  expiresOn: string | null;
}

export interface MockStock {
  warehouses: Warehouse[];
  movements: MockMovement[];
  batches: MockBatch[];
  // variant|serial → its warehouse now (null = not in stock)
  serials: Map<string, string | null>;
  levels: {
    warehouseId: string;
    variantId: string;
    minQuantity: string;
    reorderQuantity: string | null;
  }[];
  adjustments: StockAdjustment[];
  transfers: StockTransfer[];
  // Step 14: variant → its value (kept like the API's trigger, as each movement is written)
  values: Map<string, ValueState>;
  revaluations: StockRevaluation[];
  counters: { adjustment: number; transfer: number; revaluation: number };
}

export function emptyStock(): MockStock {
  return {
    warehouses: [],
    movements: [],
    batches: [],
    serials: new Map(),
    levels: [],
    adjustments: [],
    transfers: [],
    values: new Map(),
    revaluations: [],
    counters: { adjustment: 0, transfer: 0, revaluation: 0 },
  };
}

// The new state after a movement, like migration 0024's trigger: the average follows the stock
// while there is some, and keeps its last value at zero or below
function applyValue(state: ValueState, quantity: string, value: string): ValueState {
  const next = {
    quantity: addQuantity(state.quantity, quantity),
    value: addMoney(state.value, value),
  };
  return {
    ...next,
    unitCost:
      compareQuantity(next.quantity, '0') > 0
        ? unitCostOf(next.value, next.quantity)
        : state.unitCost,
  };
}

function valueOf(stock: MockStock, variantId: string): ValueState {
  return stock.values.get(variantId) ?? { quantity: '0', value: '0.0000', unitCost: null };
}

// Writes a movement and adds it to its variant's value, like the trigger
function pushMovement(stock: MockStock, movement: MockMovement): void {
  stock.movements.push(movement);
  stock.values.set(
    movement.variantId,
    applyValue(valueOf(stock, movement.variantId), movement.quantity, movement.value),
  );
}

// The API's outflowValue(): all of it takes all the value, part takes its share, more than there
// is takes what there was and the rest at the last average
function outflowValue(state: ValueState, quantity: string): string {
  const positive = compareQuantity(state.quantity, '0') > 0;
  if (positive && compareQuantity(quantity, state.quantity) === 0) return state.value;
  if (positive && compareQuantity(quantity, state.quantity) < 0) {
    return prorateMoney(state.value, quantity, state.quantity);
  }
  const beyond = positive ? subtractQuantity(quantity, state.quantity) : quantity;
  return addMoney(positive ? state.value : '0', multiplyMoney(beyond, state.unitCost ?? '0'));
}

function now(): string {
  return new Date().toISOString();
}

// "1200" → "1200.0000", the way Postgres sends NUMERIC(19,4); null stays null
function fixedOrNull(value: string | null): string | null {
  return value === null ? null : addMoney(value, '0');
}

export function warehouse(
  branchId: string,
  code: string,
  name: string,
  address: string | null,
): Warehouse {
  return {
    id: crypto.randomUUID(),
    branchId,
    code,
    name,
    address,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
}

// --- Variants -----------------------------------------------------------------------------------

function findVariant(
  data: WorkspaceData,
  variantId: string,
): { product: Product; variant: ProductVariant } | undefined {
  for (const product of data.catalog.products) {
    const variant = product.variants.find((candidate) => candidate.id === variantId);
    if (variant) return { product, variant };
  }
  return undefined;
}

function decimalsOf(data: WorkspaceData, unitId: string): number {
  return data.catalog.units.find((unit) => unit.id === unitId)?.decimals ?? 0;
}

// warehouse|variant → on hand, and warehouse|variant|batch → on hand, from every movement
function balancesOf(stock: MockStock) {
  const byPlace = new Map<string, string>();
  const byBatch = new Map<string, string>();
  for (const movement of stock.movements) {
    const place = `${movement.warehouseId}|${movement.variantId}`;
    byPlace.set(place, addQuantity(byPlace.get(place) ?? '0', movement.quantity));
    const batch = `${place}|${movement.batchId ?? ''}`;
    byBatch.set(batch, addQuantity(byBatch.get(batch) ?? '0', movement.quantity));
  }
  return { byPlace, byBatch };
}

function onHand(
  stock: MockStock,
  balances: ReturnType<typeof balancesOf>,
  variantId: string,
  warehouseId: string | undefined,
): string {
  const places =
    warehouseId === undefined ? stock.warehouses.map((place) => place.id) : [warehouseId];
  return sumQuantity(places.map((place) => balances.byPlace.get(`${place}|${variantId}`) ?? '0'));
}

function inTransit(stock: MockStock, variantId: string, toWarehouseId: string | undefined): string {
  return sumQuantity(
    stock.transfers
      .filter(
        (transfer) =>
          transfer.status === 'in_transit' &&
          (toWarehouseId === undefined || transfer.toWarehouseId === toWarehouseId),
      )
      .flatMap((transfer) =>
        transfer.lines
          .filter((line) => line.variantId === variantId)
          .map((line) => line.baseQuantity),
      ),
  );
}

function isLow(
  stock: MockStock,
  balances: ReturnType<typeof balancesOf>,
  variantId: string,
  warehouseId: string | undefined,
): boolean {
  return stock.levels.some(
    (level) =>
      level.variantId === variantId &&
      (warehouseId === undefined || level.warehouseId === warehouseId) &&
      compareQuantity(
        balances.byPlace.get(`${level.warehouseId}|${variantId}`) ?? '0',
        level.minQuantity,
      ) <= 0,
  );
}

function refOf(product: Product, variant: ProductVariant) {
  return {
    variantId: variant.id,
    productId: product.id,
    productCode: product.code,
    productName: product.name,
    optionValues: variant.optionValues,
    sku: variant.sku,
    baseUnitId: product.baseUnitId,
  };
}

function itemOf(
  data: WorkspaceData,
  balances: ReturnType<typeof balancesOf>,
  product: Product,
  variant: ProductVariant,
  warehouseId: string | undefined,
): StockItem {
  const { stock } = data;
  return {
    ...refOf(product, variant),
    tracking: product.tracking,
    hasExpiry: product.hasExpiry,
    units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
    archived: product.archivedAt !== null || variant.archivedAt !== null,
    onHand: onHand(stock, balances, variant.id, warehouseId),
    inTransit: inTransit(stock, variant.id, warehouseId),
    low: isLow(stock, balances, variant.id, warehouseId),
    ...valueFields(stock, balances, variant.id, warehouseId),
  };
}

// The mock signs everyone in as the owner, who sees costs (inventory.stock.value)
function valueFields(
  stock: MockStock,
  balances: ReturnType<typeof balancesOf>,
  variantId: string,
  warehouseId: string | undefined,
): { unitCost: string | null; value: string | null } {
  const state = stock.values.get(variantId);
  if (!state) return { unitCost: null, value: null };
  return {
    unitCost: state.unitCost,
    value:
      warehouseId === undefined
        ? state.value
        : multiplyMoney(onHand(stock, balances, variantId, warehouseId), state.unitCost ?? '0'),
  };
}

// --- Reading ------------------------------------------------------------------------------------

export function listStock(
  data: WorkspaceData,
  query: StockListQuery & { filter: string },
): StockItem[] {
  const balances = balancesOf(data.stock);
  const search = query.search?.trim().toLowerCase() ?? '';
  const categories = new Set<string>();
  if (query.categoryId !== undefined) {
    // The category and everything under it, like the API
    const walk = (id: string) => {
      categories.add(id);
      data.catalog.categories
        .filter((category) => category.parentId === id)
        .forEach((child) => {
          walk(child.id);
        });
    };
    walk(query.categoryId);
  }
  return data.catalog.products
    .filter((product) => product.type === 'goods')
    .filter(
      (product) =>
        query.categoryId === undefined ||
        (product.categoryId !== null && categories.has(product.categoryId)),
    )
    .toSorted((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .flatMap((product) =>
      product.variants
        .filter((variant) => {
          if (search === '') return true;
          const serial = data.stock.serials.has(`${variant.id}|${query.search?.trim() ?? ''}`);
          return (
            product.name.toLowerCase().includes(search) ||
            product.code.toLowerCase().includes(search) ||
            variant.sku.toLowerCase().includes(search) ||
            variant.barcode === query.search?.trim() ||
            serial
          );
        })
        .map((variant) => itemOf(data, balances, product, variant, query.warehouseId)),
    )
    .filter((item) => !item.archived || compareQuantity(item.onHand, '0') !== 0)
    .filter((item) => query.filter !== 'in_stock' || compareQuantity(item.onHand, '0') > 0)
    .filter((item) => query.filter !== 'low' || item.low);
}

export function cardOf(data: WorkspaceData, variantId: string): StockCard {
  const found = findVariant(data, variantId);
  if (found?.product.type !== 'goods') throw new MockProblem(404, 'not_found');
  const { stock } = data;
  const balances = balancesOf(stock);
  const places = stock.warehouses.filter(
    (place) =>
      place.archivedAt === null ||
      compareQuantity(balances.byPlace.get(`${place.id}|${variantId}`) ?? '0', '0') !== 0,
  );
  return {
    item: itemOf(data, balances, found.product, found.variant, undefined),
    warehouses: places.map((place) => {
      const level = stock.levels.find(
        (row) => row.warehouseId === place.id && row.variantId === variantId,
      );
      return {
        warehouseId: place.id,
        onHand: onHand(stock, balances, variantId, place.id),
        inTransit: inTransit(stock, variantId, place.id),
        minQuantity: level?.minQuantity ?? null,
        reorderQuantity: level?.reorderQuantity ?? null,
      };
    }),
    batches: stock.batches
      .filter((batch) => batch.variantId === variantId)
      .flatMap((batch) =>
        stock.warehouses.flatMap((place) => {
          const quantity = balances.byBatch.get(`${place.id}|${variantId}|${batch.id}`) ?? '0';
          return compareQuantity(quantity, '0') > 0
            ? [
                {
                  batchId: batch.id,
                  lotNumber: batch.lotNumber,
                  manufacturedOn: batch.manufacturedOn,
                  expiresOn: batch.expiresOn,
                  warehouseId: place.id,
                  quantity,
                },
              ]
            : [];
        }),
      )
      // FEFO: the batch that expires first on top, no expiry last
      .toSorted((a, b) => (a.expiresOn ?? '9999-12-31').localeCompare(b.expiresOn ?? '9999-12-31')),
    serials: [...stock.serials]
      .filter(([key]) => key.startsWith(`${variantId}|`))
      .flatMap(([key, warehouseId]) => {
        const serialNumber = key.slice(variantId.length + 1);
        const travelling = stock.transfers.some(
          (transfer) =>
            transfer.status === 'in_transit' &&
            transfer.lines.some(
              (line) => line.variantId === variantId && line.serialNumbers.includes(serialNumber),
            ),
        );
        return warehouseId !== null || travelling ? [{ serialNumber, warehouseId }] : [];
      })
      .toSorted((a, b) => a.serialNumber.localeCompare(b.serialNumber)),
  };
}

export function movementsOf(
  data: WorkspaceData,
  variantId: string,
  query: { warehouseId?: string | undefined; from?: string | undefined; to?: string | undefined },
): { items: StockMovement[]; openingBalance: string; closingBalance: string } {
  if (!findVariant(data, variantId)) throw new MockProblem(404, 'not_found');
  const rows = data.stock.movements.filter(
    (movement) =>
      movement.variantId === variantId &&
      (query.warehouseId === undefined || movement.warehouseId === query.warehouseId),
  );
  const before = rows.filter((row) => query.from !== undefined && row.date < query.from);
  const shown = rows.filter(
    (row) =>
      (query.from === undefined || row.date >= query.from) &&
      (query.to === undefined || row.date <= query.to),
  );
  const openingBalance = sumQuantity(before.map((row) => row.quantity));
  let balance = openingBalance;
  const items = shown.map((row) => {
    balance = addQuantity(balance, row.quantity);
    return {
      id: row.id,
      date: row.date,
      warehouseId: row.warehouseId,
      kind: row.kind,
      documentId: row.documentId,
      documentNumber: row.documentNumber,
      quantity: row.quantity,
      balance,
      value: row.value,
      lotNumber: data.stock.batches.find((batch) => batch.id === row.batchId)?.lotNumber ?? null,
      serialNumber: row.serialNumber,
    };
  });
  const closingBalance = sumQuantity(
    rows.filter((row) => query.to === undefined || row.date <= query.to).map((row) => row.quantity),
  );
  return { items, openingBalance, closingBalance };
}

export function batchReport(
  data: WorkspaceData,
  query: { warehouseId?: string | undefined; expiresWithin?: number | undefined },
): BatchStock[] {
  const today = todayIn(data.settings.timezone);
  const until =
    query.expiresWithin === undefined
      ? null
      : new Date(Date.parse(`${today}T00:00:00Z`) + query.expiresWithin * 86_400_000)
          .toISOString()
          .slice(0, 10);
  const balances = balancesOf(data.stock);
  return data.stock.batches
    .filter((batch) => until === null || (batch.expiresOn !== null && batch.expiresOn <= until))
    .flatMap((batch) => {
      const found = findVariant(data, batch.variantId);
      if (!found) return [];
      return data.stock.warehouses
        .filter((place) => query.warehouseId === undefined || place.id === query.warehouseId)
        .flatMap((place) => {
          const quantity =
            balances.byBatch.get(`${place.id}|${batch.variantId}|${batch.id}`) ?? '0';
          return compareQuantity(quantity, '0') > 0
            ? [
                {
                  ...refOf(found.product, found.variant),
                  batchId: batch.id,
                  lotNumber: batch.lotNumber,
                  manufacturedOn: batch.manufacturedOn,
                  expiresOn: batch.expiresOn,
                  warehouseId: place.id,
                  quantity,
                },
              ]
            : [];
        });
    })
    .toSorted((a, b) => (a.expiresOn ?? '9999-12-31').localeCompare(b.expiresOn ?? '9999-12-31'));
}

export function reorderReport(data: WorkspaceData, warehouseId: string | undefined): ReorderItem[] {
  const balances = balancesOf(data.stock);
  return data.stock.levels
    .filter((level) => warehouseId === undefined || level.warehouseId === warehouseId)
    .flatMap((level) => {
      const found = findVariant(data, level.variantId);
      const here = balances.byPlace.get(`${level.warehouseId}|${level.variantId}`) ?? '0';
      if (!found || compareQuantity(here, level.minQuantity) > 0) return [];
      return [
        {
          ...refOf(found.product, found.variant),
          warehouseId: level.warehouseId,
          onHand: here,
          inTransit: inTransit(data.stock, level.variantId, level.warehouseId),
          minQuantity: level.minQuantity,
          reorderQuantity: level.reorderQuantity,
        },
      ];
    });
}

export function setLevel(data: WorkspaceData, input: ReorderLevelInput) {
  const { stock } = data;
  stock.levels = stock.levels.filter(
    (level) => !(level.warehouseId === input.warehouseId && level.variantId === input.variantId),
  );
  if (input.minQuantity !== null) {
    stock.levels.push({
      warehouseId: input.warehouseId,
      variantId: input.variantId,
      minQuantity: input.minQuantity,
      reorderQuantity: input.reorderQuantity,
    });
  }
  return {
    warehouseId: input.warehouseId,
    variantId: input.variantId,
    minQuantity: input.minQuantity,
    reorderQuantity: input.minQuantity === null ? null : input.reorderQuantity,
  };
}

// --- Documents ----------------------------------------------------------------------------------

interface LineInput {
  variantId: string;
  unitId: string;
  quantity: string;
  batchId: string | null;
  serialNumbers: string[];
  lotNumber?: string | null;
  expiresOn?: string | null;
  manufacturedOn?: string | null;
  unitCost?: string | null;
}

function issuesError(issues: { path: string; code: ErrorCode }[]): MockProblem {
  const fieldErrors: Record<string, ErrorCode[]> = {};
  for (const issue of issues) (fieldErrors[issue.path] ??= []).push(issue.code);
  return new MockProblem(409, issues[0]?.code ?? 'invalid_input', fieldErrors);
}

// The API's line rules (stock-lines.ts), shortened: a stocked product, its unit, the decimals,
// and what its tracking asks for. Returns the lines as the API stores them.
function resolveLines(
  data: WorkspaceData,
  lines: readonly LineInput[],
  mode: 'in' | 'out',
): StockLine[] {
  const issues: { path: string; code: ErrorCode }[] = [];
  const resolved = lines.flatMap((line, index): StockLine[] => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    const found = findVariant(data, line.variantId);
    if (found?.product.type !== 'goods') {
      at('variantId', 'stock_variant_invalid');
      return [];
    }
    const { product, variant } = found;
    const factor =
      line.unitId === product.baseUnitId
        ? '1'
        : product.units.find((pack) => pack.unitId === line.unitId)?.factor;
    if (factor === undefined) {
      at('unitId', 'stock_unit_invalid');
      return [];
    }
    if (!isQuantity(line.quantity)) {
      at('quantity', 'quantity_format');
      return [];
    }
    if (!fitsDecimals(line.quantity, decimalsOf(data, line.unitId))) {
      at('quantity', 'stock_quantity_decimals');
      return [];
    }
    const baseQuantity = toBaseQuantity(
      line.quantity,
      factor,
      decimalsOf(data, product.baseUnitId),
    );
    let batch: MockBatch | undefined;
    if (product.tracking === 'batch' && mode === 'in' && !line.lotNumber)
      at('lotNumber', 'stock_lot_required');
    if (product.tracking === 'batch' && mode === 'out') {
      batch = data.stock.batches.find((candidate) => candidate.id === line.batchId);
      if (line.batchId === null) at('batchId', 'stock_batch_required');
      else if (batch?.variantId !== variant.id) at('batchId', 'stock_batch_invalid');
    }
    if (
      product.tracking === 'serial' &&
      (!isWholeQuantity(baseQuantity) || wholeCount(baseQuantity) !== line.serialNumbers.length)
    ) {
      at('serialNumbers', 'stock_serial_count');
    }
    return [
      {
        ...refOf(product, variant),
        id: crypto.randomUUID(),
        tracking: product.tracking,
        hasExpiry: product.hasExpiry,
        units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
        unitId: line.unitId,
        quantity: addQuantity(line.quantity, '0'),
        baseQuantity,
        batchId: product.tracking === 'batch' && mode === 'out' ? line.batchId : null,
        lotNumber:
          product.tracking === 'batch'
            ? mode === 'in'
              ? (line.lotNumber ?? null)
              : (batch?.lotNumber ?? null)
            : null,
        expiresOn:
          product.tracking === 'batch'
            ? mode === 'in'
              ? (line.expiresOn ?? null)
              : (batch?.expiresOn ?? null)
            : null,
        manufacturedOn:
          mode === 'in' ? (line.manufacturedOn ?? null) : (batch?.manufacturedOn ?? null),
        serialNumbers: product.tracking === 'serial' ? line.serialNumbers : [],
      },
    ];
  });
  if (issues.length > 0) throw issuesError(issues);
  return resolved;
}

function assertWarehouses(data: WorkspaceData, places: { field: string; id: string }[]): void {
  const bad = places.filter(
    (place) => !data.stock.warehouses.some((row) => row.id === place.id && row.archivedAt === null),
  );
  if (bad.length > 0) {
    throw new MockProblem(
      409,
      'stock_warehouse_invalid',
      Object.fromEntries(bad.map((place) => [place.field, ['stock_warehouse_invalid' as const]])),
    );
  }
}

function assertDate(data: WorkspaceData, date: string): void {
  if (date > todayIn(data.settings.timezone)) {
    throw new MockProblem(409, 'stock_date_future', { date: ['stock_date_future'] });
  }
}

function nextNumber(
  data: WorkspaceData,
  type: 'inventory.adjustment' | 'inventory.transfer' | 'inventory.revaluation',
  date: string,
): string {
  const format = defaultNumberFormat(type);
  const key =
    type === 'inventory.adjustment'
      ? 'adjustment'
      : type === 'inventory.transfer'
        ? 'transfer'
        : 'revaluation';
  data.stock.counters[key] += 1;
  return formatDocumentNumber(
    format,
    periodOf(date, format.yearStyle, data.settings.fiscalYearStartMonth),
    data.stock.counters[key],
  );
}

interface Move {
  line: number;
  warehouseId: string;
  stockLine: StockLine;
  batchId: string | null;
  quantity: string;
  serialNumbers: string[];
  // An "in" move's value; null = at the average cost (step 14)
  value?: string | null;
}

// The API's StockPostingService.post(), shortened: serial numbers and stock checked, the values
// worked out (step 14), then the movements written (one per serial number for a serial product).
// Returns each move's value.
function postMoves(
  data: WorkspaceData,
  posting: {
    date: string;
    kind: MovementKind;
    direction: 'in' | 'out';
    documentId: string;
    number: string;
  },
  moves: readonly Move[],
  receivingTransferId?: string,
): string[] {
  const { stock } = data;
  const issues: { path: string; code: ErrorCode }[] = [];
  const balances = balancesOf(stock);
  const wanted = new Map<string, string>();
  for (const move of moves) {
    const key = `${move.warehouseId}|${move.stockLine.variantId}|${move.batchId ?? ''}`;
    wanted.set(key, addQuantity(wanted.get(key) ?? '0', move.quantity));
  }
  for (const move of moves) {
    const travelling = (serial: string) =>
      stock.transfers.some(
        (transfer) =>
          transfer.id !== receivingTransferId &&
          transfer.status === 'in_transit' &&
          transfer.lines.some(
            (line) =>
              line.variantId === move.stockLine.variantId && line.serialNumbers.includes(serial),
          ),
      );
    const badSerial = move.serialNumbers.some((serial) => {
      const at = stock.serials.get(`${move.stockLine.variantId}|${serial}`);
      return posting.direction === 'in'
        ? (at !== undefined && at !== null) || travelling(serial)
        : at !== move.warehouseId;
    });
    if (badSerial) {
      issues.push({
        path: `lines.${String(move.line)}.serialNumbers`,
        code: posting.direction === 'in' ? 'stock_serial_in_stock' : 'stock_serial_not_here',
      });
    }
    if (posting.direction === 'out') {
      const key = `${move.warehouseId}|${move.stockLine.variantId}|${move.batchId ?? ''}`;
      const allowed = move.stockLine.tracking === 'none' && data.settings.allowNegativeStock;
      if (
        !allowed &&
        compareQuantity(balances.byBatch.get(key) ?? '0', wanted.get(key) ?? '0') < 0
      ) {
        issues.push({ path: `lines.${String(move.line)}.quantity`, code: 'stock_insufficient' });
      }
    }
  }
  if (issues.length > 0) throw issuesError(issues);

  // The values, in the document's order, each from what the one before left
  const states = new Map<string, ValueState>();
  const values = moves.map((move) => {
    const variantId = move.stockLine.variantId;
    const state = states.get(variantId) ?? valueOf(stock, variantId);
    let value: string;
    if (posting.direction === 'out') {
      value = outflowValue(state, move.quantity);
      states.set(variantId, applyValue(state, negateQuantity(move.quantity), negateMoney(value)));
    } else {
      const given = move.value ?? null;
      if (given === null && state.unitCost === null) {
        issues.push({ path: `lines.${String(move.line)}.unitCost`, code: 'stock_cost_required' });
      }
      value = given ?? multiplyMoney(move.quantity, state.unitCost ?? '0');
      states.set(variantId, applyValue(state, move.quantity, value));
    }
    return value;
  });
  if (issues.length > 0) throw issuesError(issues);
  const signed = (value: string) => (posting.direction === 'in' ? value : negateMoney(value));

  moves.forEach((move, index) => {
    const value = values[index] ?? '0';
    const base = {
      date: posting.date,
      warehouseId: move.warehouseId,
      productId: move.stockLine.productId,
      variantId: move.stockLine.variantId,
      batchId: move.batchId,
      kind: posting.kind,
      documentId: posting.documentId,
      documentNumber: posting.number,
    };
    if (move.serialNumbers.length > 0) {
      const pieces = splitMoney(value, move.serialNumbers.length);
      move.serialNumbers.forEach((serial, piece) => {
        pushMovement(stock, {
          ...base,
          id: crypto.randomUUID(),
          serialNumber: serial,
          quantity: posting.direction === 'in' ? '1.0000' : '-1.0000',
          value: signed(pieces[piece] ?? '0'),
        });
        stock.serials.set(
          `${move.stockLine.variantId}|${serial}`,
          posting.direction === 'in' ? move.warehouseId : null,
        );
      });
    } else {
      pushMovement(stock, {
        ...base,
        id: crypto.randomUUID(),
        serialNumber: null,
        quantity: posting.direction === 'in' ? move.quantity : negateQuantity(move.quantity),
        value: signed(value),
      });
    }
  });
  return values;
}

// --- The books (step 14, the API's StockBooksService) --------------------------------------------

function branchOf(data: WorkspaceData, warehouseId: string): string | null {
  return data.stock.warehouses.find((place) => place.id === warehouseId)?.branchId ?? null;
}

function bookAccounts(data: WorkspaceData) {
  const inventory = data.accounts.find((account) => account.purpose === 'inventory')?.id;
  const equity = data.accounts.find((account) => account.purpose === 'opening_balance_equity')?.id;
  if (inventory === undefined || equity === undefined) {
    throw new MockProblem(409, 'stock_account_missing');
  }
  const use = (key: keyof WorkspaceData['stockAccounts']): string => {
    const id = data.stockAccounts[key];
    const account = data.accounts.find((row) => row.id === id);
    if (!account || account.isGroup || account.archivedAt !== null) {
      throw new MockProblem(409, 'stock_account_missing');
    }
    return account.id;
  };
  return { inventory, equity, use };
}

export function findAdjustment(data: WorkspaceData, id: string): StockAdjustment {
  const found = data.stock.adjustments.find((adjustment) => adjustment.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function saveAdjustment(
  data: WorkspaceData,
  input: Omit<StockAdjustmentInput, 'post'>,
  existing?: StockAdjustment,
): StockAdjustment {
  assertWarehouses(data, [{ field: 'warehouseId', id: input.warehouseId }]);
  const lines: AdjustmentLine[] = resolveLines(data, input.lines, input.direction).map(
    (line, index) => ({
      ...line,
      // A typed cost belongs on an "in" line only, like the API
      unitCost: input.direction === 'in' ? fixedOrNull(input.lines[index]?.unitCost ?? null) : null,
      value: null,
    }),
  );
  const saved: StockAdjustment = {
    id: existing?.id ?? crypto.randomUUID(),
    number: null,
    date: input.date,
    warehouseId: input.warehouseId,
    direction: input.direction,
    reason: input.reason,
    note: input.note,
    status: 'draft',
    lineCount: lines.length,
    postedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
    lines,
    entry: null,
  };
  data.stock.adjustments = [saved, ...data.stock.adjustments.filter((row) => row.id !== saved.id)];
  return saved;
}

export function postAdjustment(data: WorkspaceData, draft: StockAdjustment): StockAdjustment {
  if (draft.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
  assertDate(data, draft.date);
  const direction = draft.direction === 'out' ? 'out' : 'in';
  // An "in" line's lot becomes a batch: an existing one of the variant, or a new one
  const issues: { path: string; code: ErrorCode }[] = [];
  const lines = draft.lines.map((line, index) => {
    if (direction !== 'in' || line.lotNumber === null) return line;
    const lot = line.lotNumber;
    let batch = data.stock.batches.find(
      (candidate) =>
        candidate.variantId === line.variantId &&
        candidate.lotNumber.toLowerCase() === lot.toLowerCase(),
    );
    if (!batch) {
      if (line.hasExpiry && line.expiresOn === null) {
        issues.push({ path: `lines.${String(index)}.expiresOn`, code: 'stock_expiry_required' });
        return line;
      }
      batch = {
        id: crypto.randomUUID(),
        variantId: line.variantId,
        lotNumber: lot,
        manufacturedOn: line.manufacturedOn,
        expiresOn: line.expiresOn,
      };
      data.stock.batches.push(batch);
    } else if (line.expiresOn !== null && line.expiresOn !== batch.expiresOn) {
      issues.push({
        path: `lines.${String(index)}.expiresOn`,
        code: 'stock_batch_expiry_mismatch',
      });
    }
    return { ...line, batchId: batch.id, expiresOn: batch.expiresOn };
  });
  if (issues.length > 0) throw issuesError(issues);
  // The accounts first: a missing one refuses the posting before anything moves
  const accounts = bookAccounts(data);
  const reason = draft.reason;
  // Opening stock is against opening balance equity; every other reason has its own account
  const against =
    !isAdjustmentReason(reason) || reason === 'opening' ? accounts.equity : accounts.use(reason);
  const number = nextNumber(data, 'inventory.adjustment', draft.date);
  let values: string[];
  try {
    values = postMoves(
      data,
      { date: draft.date, kind: 'adjustment', direction, documentId: draft.id, number },
      lines.map((line, index) => ({
        line: index,
        warehouseId: draft.warehouseId,
        stockLine: line,
        batchId: line.batchId,
        quantity: line.baseQuantity,
        serialNumbers: line.serialNumbers,
        value: line.unitCost === null ? null : multiplyMoney(line.quantity, line.unitCost),
      })),
    );
  } catch (error) {
    // The API's transaction gives the number back; so does the mock
    data.stock.counters.adjustment -= 1;
    throw error;
  }
  const total = sumMoney(values);
  const branchId = branchOf(data, draft.warehouseId);
  const sign = (value: string) => (direction === 'in' ? value : negateMoney(value));
  const entry = postStockEntry(data, {
    date: draft.date,
    source: 'stock_adjustment',
    document: { id: draft.id, number },
    narration: `Stock adjustment ${number}`,
    amounts: [
      { accountId: accounts.inventory, branchId, amount: sign(total) },
      { accountId: against, branchId, amount: negateMoney(sign(total)) },
    ],
  });
  const posted: StockAdjustment = {
    ...draft,
    lines: lines.map((line, index) => ({ ...line, value: values[index] ?? null })),
    entry,
    number,
    status: 'posted',
    postedAt: now(),
    version: draft.version + 1,
    updatedAt: now(),
  };
  data.stock.adjustments = data.stock.adjustments.map((row) =>
    row.id === posted.id ? posted : row,
  );
  return posted;
}

export function findTransfer(data: WorkspaceData, id: string): StockTransfer {
  const found = data.stock.transfers.find((transfer) => transfer.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function saveTransfer(
  data: WorkspaceData,
  input: Omit<StockTransferInput, 'send'>,
  existing?: StockTransfer,
): StockTransfer {
  assertWarehouses(data, [
    { field: 'fromWarehouseId', id: input.fromWarehouseId },
    { field: 'toWarehouseId', id: input.toWarehouseId },
  ]);
  const lines: TransferLine[] = resolveLines(data, input.lines, 'out').map((line) => ({
    ...line,
    receivedQuantity: null,
    receivedSerialNumbers: null,
    value: null,
    receivedValue: null,
  }));
  const saved: StockTransfer = {
    id: existing?.id ?? crypto.randomUUID(),
    number: null,
    status: 'draft',
    fromWarehouseId: input.fromWarehouseId,
    toWarehouseId: input.toWarehouseId,
    sentOn: input.date,
    receivedOn: null,
    note: input.note,
    lineCount: lines.length,
    short: false,
    sentAt: null,
    receivedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
    lines,
    entries: [],
  };
  data.stock.transfers = [saved, ...data.stock.transfers.filter((row) => row.id !== saved.id)];
  return saved;
}

export function sendTransfer(data: WorkspaceData, draft: StockTransfer): StockTransfer {
  if (draft.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
  assertDate(data, draft.sentOn);
  const from = branchOf(data, draft.fromWarehouseId);
  const crossing = from !== branchOf(data, draft.toWarehouseId);
  // Between branches the goods go through goods in transit: its account must be there first
  const accounts = crossing ? bookAccounts(data) : null;
  const inTransitAccount = accounts?.use('in_transit') ?? null;
  const number = nextNumber(data, 'inventory.transfer', draft.sentOn);
  let values: string[];
  try {
    values = postMoves(
      data,
      { date: draft.sentOn, kind: 'transfer_out', direction: 'out', documentId: draft.id, number },
      draft.lines.map((line, index) => ({
        line: index,
        warehouseId: draft.fromWarehouseId,
        stockLine: line,
        batchId: line.batchId,
        quantity: line.baseQuantity,
        serialNumbers: line.serialNumbers,
      })),
    );
  } catch (error) {
    data.stock.counters.transfer -= 1;
    throw error;
  }
  const total = sumMoney(values);
  const entry =
    accounts && inTransitAccount
      ? postStockEntry(data, {
          date: draft.sentOn,
          source: 'stock_transfer',
          document: { id: draft.id, number },
          narration: `Stock transfer ${number} sent`,
          amounts: [
            { accountId: inTransitAccount, branchId: null, amount: total },
            { accountId: accounts.inventory, branchId: from, amount: negateMoney(total) },
          ],
        })
      : null;
  const sent: StockTransfer = {
    ...draft,
    lines: draft.lines.map((line, index) => ({ ...line, value: values[index] ?? null })),
    entries: entry ? [entry] : [],
    number,
    status: 'in_transit',
    sentAt: now(),
    version: draft.version + 1,
    updatedAt: now(),
  };
  data.stock.transfers = data.stock.transfers.map((row) => (row.id === sent.id ? sent : row));
  return sent;
}

export function receiveTransfer(
  data: WorkspaceData,
  transfer: StockTransfer,
  input: {
    date: string;
    lines: { lineId: string; receivedQuantity: string; serialNumbers: string[] }[];
  },
): StockTransfer {
  if (transfer.status !== 'in_transit') throw new MockProblem(409, 'transfer_not_in_transit');
  if (input.date < transfer.sentOn) {
    throw new MockProblem(409, 'transfer_receive_date', { date: ['transfer_receive_date'] });
  }
  assertDate(data, input.date);
  const issues: { path: string; code: ErrorCode }[] = [];
  const lines = transfer.lines.map((line) => {
    const index = input.lines.findIndex((received) => received.lineId === line.id);
    const received = input.lines[index];
    if (!received)
      throw new MockProblem(409, 'transfer_lines_mismatch', { lines: ['transfer_lines_mismatch'] });
    if (compareQuantity(received.receivedQuantity, line.baseQuantity) > 0) {
      issues.push({
        path: `lines.${String(index)}.receivedQuantity`,
        code: 'transfer_receive_too_many',
      });
    }
    return {
      index,
      line: {
        ...line,
        receivedQuantity: addQuantity(received.receivedQuantity, '0'),
        receivedSerialNumbers: received.serialNumbers,
      },
    };
  });
  if (issues.length > 0) throw issuesError(issues);
  // What arrived is worth the same per unit as what left (the API's receivedValueOf())
  const receivedValues = lines.map(({ line }) => {
    const sentValue = line.value ?? '0';
    if (compareQuantity(line.receivedQuantity, line.baseQuantity) === 0) return sentValue;
    if (isZeroQuantity(line.receivedQuantity)) return '0.0000';
    return prorateMoney(sentValue, line.receivedQuantity, line.baseQuantity);
  });
  const from = branchOf(data, transfer.fromWarehouseId);
  const to = branchOf(data, transfer.toWarehouseId);
  const sentTotal = sumMoney(lines.map(({ line }) => line.value ?? '0'));
  const receivedTotal = sumMoney(receivedValues);
  const short = subtractMoney(sentTotal, receivedTotal);
  const needsBooks = from !== to || !isZeroMoney(short);
  const accounts = needsBooks ? bookAccounts(data) : null;
  const shortageAccount =
    accounts && !isZeroMoney(short) ? accounts.use('transfer_shortage') : null;
  const inTransitAccount = accounts && from !== to ? accounts.use('in_transit') : null;
  postMoves(
    data,
    {
      date: input.date,
      kind: 'transfer_in',
      direction: 'in',
      documentId: transfer.id,
      number: transfer.number ?? '',
    },
    lines.flatMap(({ index, line }) =>
      compareQuantity(line.receivedQuantity, '0') === 0
        ? []
        : [
            {
              line: index,
              warehouseId: transfer.toWarehouseId,
              stockLine: line,
              batchId: line.batchId,
              quantity: line.receivedQuantity,
              serialNumbers: line.receivedSerialNumbers,
              value: receivedValues[index] ?? '0',
            },
          ],
    ),
    transfer.id,
  );
  const document = { id: transfer.id, number: transfer.number ?? '' };
  const narration = `Stock transfer ${transfer.number ?? ''} received`;
  const shortage = shortageAccount
    ? [{ accountId: shortageAccount, branchId: from, amount: short }]
    : [];
  const entry = !accounts
    ? null
    : inTransitAccount
      ? postStockEntry(data, {
          date: input.date,
          source: 'stock_transfer',
          document,
          narration,
          amounts: [
            { accountId: accounts.inventory, branchId: to, amount: receivedTotal },
            ...shortage,
            { accountId: inTransitAccount, branchId: null, amount: negateMoney(sentTotal) },
          ],
        })
      : postStockEntry(data, {
          date: input.date,
          source: 'stock_transfer',
          document,
          narration,
          amounts: [
            ...shortage,
            { accountId: accounts.inventory, branchId: from, amount: negateMoney(short) },
          ],
        });
  const received: StockTransfer = {
    ...transfer,
    lines: lines.map(({ line }, index) => ({
      ...line,
      receivedValue: receivedValues[index] ?? null,
    })),
    entries: entry ? [...transfer.entries, entry] : transfer.entries,
    status: 'received',
    receivedOn: input.date,
    receivedAt: now(),
    short: lines.some(({ line }) => compareQuantity(line.receivedQuantity, line.baseQuantity) < 0),
    version: transfer.version + 1,
    updatedAt: now(),
  };
  data.stock.transfers = data.stock.transfers.map((row) =>
    row.id === received.id ? received : row,
  );
  return received;
}

// --- Values (step 14) ---------------------------------------------------------------------------

export function valuationList(
  data: WorkspaceData,
  query: { search?: string | undefined; categoryId?: string | undefined },
): StockValue[] {
  const search = query.search?.trim().toLowerCase() ?? '';
  return data.catalog.products
    .filter((product) => query.categoryId === undefined || product.categoryId === query.categoryId)
    .toSorted((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .flatMap((product) =>
      product.variants.flatMap((variant) => {
        const state = data.stock.values.get(variant.id);
        if (!state || (isZeroQuantity(state.quantity) && isZeroMoney(state.value))) return [];
        const matches =
          search === '' ||
          product.name.toLowerCase().includes(search) ||
          product.code.toLowerCase().includes(search) ||
          variant.sku.toLowerCase().includes(search);
        return matches
          ? [
              {
                ...refOf(product, variant),
                quantity: state.quantity,
                unitCost: state.unitCost,
                value: state.value,
              },
            ]
          : [];
      }),
    );
}

export function valuationSummary(data: WorkspaceData): ValuationSummary {
  const stockValue = sumMoney([...data.stock.values.values()].map((state) => state.value));
  const inTransitValue = sumMoney(
    data.stock.transfers
      .filter((transfer) => transfer.status === 'in_transit')
      .flatMap((transfer) => transfer.lines.map((line) => line.value ?? '0')),
  );
  const balanceOf = (accountId: string | null | undefined) => {
    if (accountId === null || accountId === undefined) return null;
    const lines = data.journal.entries
      .filter((entry) => entry.status === 'posted')
      .flatMap((entry) => entry.lines.filter((line) => line.accountId === accountId));
    return {
      id: accountId,
      balance: subtractMoney(
        sumMoney(lines.map((line) => line.debit)),
        sumMoney(lines.map((line) => line.credit)),
      ),
    };
  };
  const inventoryAccount = balanceOf(
    data.accounts.find((account) => account.purpose === 'inventory')?.id,
  );
  const inTransitAccount = balanceOf(data.stockAccounts.in_transit);
  return {
    stockValue,
    inTransitValue,
    inventoryAccount,
    inTransitAccount,
    difference: subtractMoney(
      sumMoney([stockValue, inTransitValue]),
      sumMoney([inventoryAccount?.balance ?? '0', inTransitAccount?.balance ?? '0']),
    ),
  };
}

export function findRevaluation(data: WorkspaceData, id: string): StockRevaluation {
  const found = data.stock.revaluations.find((revaluation) => revaluation.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// The API's StockRevaluationsService.create() and StockPostingService.revalue(), shortened: the
// difference split over the warehouses holding the stock, as movements of quantity 0
export function revalue(data: WorkspaceData, input: StockRevaluationInput): StockRevaluation {
  assertDate(data, input.date);
  const { stock } = data;
  const issues: { path: string; code: ErrorCode }[] = [];
  const found = input.lines.map((line, index) => {
    const variant = findVariant(data, line.variantId);
    if (variant?.product.type !== 'goods') {
      issues.push({ path: `lines.${String(index)}.variantId`, code: 'stock_variant_invalid' });
      return null;
    }
    const state = valueOf(stock, line.variantId);
    if (compareQuantity(state.quantity, '0') <= 0) {
      issues.push({ path: `lines.${String(index)}.variantId`, code: 'revaluation_no_stock' });
      return null;
    }
    return { ...variant, state };
  });
  if (issues.length > 0) throw issuesError(issues);
  const accounts = bookAccounts(data);
  const revaluationAccount = accounts.use('revaluation');
  const id = crypto.randomUUID();
  const number = nextNumber(data, 'inventory.revaluation', input.date);
  const balances = balancesOf(stock);
  const amounts: { accountId: string; branchId: string | null; amount: string }[] = [];
  const lines = input.lines.flatMap((line, index) => {
    const item = found[index];
    if (!item) return [];
    const newValue = multiplyMoney(item.state.quantity, line.unitCost);
    const difference = subtractMoney(newValue, item.state.value);
    const places = stock.warehouses.flatMap((place) => {
      const quantity = balances.byPlace.get(`${place.id}|${line.variantId}`) ?? '0';
      return compareQuantity(quantity, '0') > 0 ? [{ warehouseId: place.id, quantity }] : [];
    });
    const held = sumQuantity(places.map((place) => place.quantity));
    let left = difference;
    places.forEach((place, at) => {
      const value =
        at === places.length - 1 ? left : prorateMoney(difference, place.quantity, held);
      left = subtractMoney(left, value);
      if (isZeroMoney(value)) return;
      pushMovement(stock, {
        id: crypto.randomUUID(),
        date: input.date,
        warehouseId: place.warehouseId,
        productId: item.product.id,
        variantId: line.variantId,
        batchId: null,
        serialNumber: null,
        quantity: '0.0000',
        value,
        kind: 'revaluation',
        documentId: id,
        documentNumber: number,
      });
      const branchId = branchOf(data, place.warehouseId);
      amounts.push(
        { accountId: accounts.inventory, branchId, amount: value },
        { accountId: revaluationAccount, branchId, amount: negateMoney(value) },
      );
    });
    return [
      {
        ...refOf(item.product, item.variant),
        id: crypto.randomUUID(),
        quantity: item.state.quantity,
        oldUnitCost: item.state.unitCost,
        oldValue: item.state.value,
        unitCost: addMoney(line.unitCost, '0'),
        newValue,
        difference,
      },
    ];
  });
  const entry = postStockEntry(data, {
    date: input.date,
    source: 'stock_revaluation',
    document: { id, number },
    narration: `Stock revaluation ${number}`,
    amounts,
  });
  const revaluation: StockRevaluation = {
    id,
    number,
    date: input.date,
    note: input.note,
    lineCount: lines.length,
    difference: sumMoney(lines.map((line) => line.difference)),
    postedAt: now(),
    lines,
    entry,
  };
  stock.revaluations = [revaluation, ...stock.revaluations];
  return revaluation;
}

// --- Seed ---------------------------------------------------------------------------------------

function daysFromToday(today: string, days: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// What a fixture workspace starts with: its warehouses, an opening stock adjustment a week ago
// (with what each item cost: step 14 posts it to the books, against opening balance equity), and
// (garments) a truck on the road to the Chattogram depot and a low stock of mailer bags
export function seedStock(data: WorkspaceData, garments: boolean): void {
  const [ho, factory, depot] = data.branches;
  if (!ho) return;
  const today = todayIn(data.settings.timezone);
  const weekAgo = daysFromToday(today, -7);
  data.stock.warehouses =
    garments && factory && depot
      ? [
          warehouse(ho.id, 'MAIN', 'Main store', 'House 42, Road 11, Banani, Dhaka 1213'),
          warehouse(
            factory.id,
            'FG',
            'Finished goods store',
            'Shed 3, BSCIC Industrial Area, Gazipur',
          ),
          warehouse(depot.id, 'CTG', 'Chattogram depot', 'Port Connecting Road, Chattogram 4100'),
        ]
      : [warehouse(ho.id, 'MAIN', 'Main store', 'Tejgaon Industrial Area, Dhaka 1208')];
  const [main] = data.stock.warehouses;
  if (!main) return;

  const byCode = (code: string) => data.catalog.products.find((product) => product.code === code);
  type SeedLine = StockAdjustmentInput['lines'][number];
  const blank = {
    batchId: null,
    lotNumber: null,
    expiresOn: null,
    manufacturedOn: null,
    unitCost: null,
  };
  const line = (code: string, quantity: string, extra: Partial<SeedLine> = {}): SeedLine[] => {
    const product = byCode(code);
    const variant = product?.variants[0];
    if (!product || !variant) return [];
    return [
      {
        ...blank,
        variantId: variant.id,
        unitId: product.baseUnitId,
        quantity,
        serialNumbers: [],
        ...extra,
      },
    ];
  };
  const opening = (lines: SeedLine[]) =>
    postAdjustment(
      data,
      saveAdjustment(data, {
        date: weekAgo,
        warehouseId: main.id,
        direction: 'in',
        reason: 'opening',
        note: null,
        lines,
      }),
    );

  if (garments) {
    const polo = byCode('ST-118');
    opening([
      ...(polo?.variants.map((variant) => ({
        ...blank,
        variantId: variant.id,
        unitId: polo.baseUnitId,
        quantity: '120',
        serialNumbers: [],
        unitCost: '410',
      })) ?? []),
      ...line('P-00001', '480', { unitCost: '185' }),
      ...line('P-00002', '1250.5', { unitCost: '520' }),
      ...line('P-00003', '7200', { unitCost: '0.45' }),
      ...line('P-00004', '3000', { unitCost: '6.5' }),
      ...line('P-00005', '3', {
        serialNumbers: ['JK8000-24-0117', 'JK8000-24-0118', 'JK8000-24-0119'],
        unitCost: '68500',
      }),
    ]);
    const mailer = byCode('P-00004')?.variants[0];
    if (mailer) {
      data.stock.levels.push({
        warehouseId: main.id,
        variantId: mailer.id,
        minQuantity: '4000',
        reorderQuantity: '10000',
      });
    }
    const depotStore = data.stock.warehouses[2];
    const tee = line('P-00001', '48');
    if (depotStore && tee.length > 0) {
      sendTransfer(
        data,
        saveTransfer(data, {
          fromWarehouseId: main.id,
          toWarehouseId: depotStore.id,
          date: daysFromToday(today, -1),
          note: 'Truck DM-TA 11-2233, driver Kamal',
          lines: tee,
        }),
      );
    }
  } else {
    opening([
      ...line('P-00001', '3000', {
        lotNumber: 'NP24090',
        expiresOn: daysFromToday(today, 25),
        unitCost: '0.85',
      }),
      ...line('P-00001', '12000', {
        lotNumber: 'NP24117',
        expiresOn: daysFromToday(today, 270),
        unitCost: '0.85',
      }),
    ]);
  }
}
