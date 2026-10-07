import {
  defaultLineDescription,
  type ErrorCode,
  fitsDecimals,
  isQuantity,
  type LineAmounts,
  lineAmounts,
  type PartyRef,
  type SalesLine,
  type SalesLineInput,
  type TaxRateKind,
  toBaseQuantity,
} from '@omnivo/contracts';
import { parties, partyAddresses, taxRates, tenantSettings } from '@omnivo/db';
import { and, eq, inArray } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import {
  type LineIssue,
  linePath,
  linesError,
  loadVariants,
  type VariantInfo,
} from '../inventory/stock-lines.js';

// What quotations and orders (and 15c's invoices) do the same way: check the customer, the address
// and the lines, work the lines out with contracts' lineAmounts(), and read them back.

function fieldError(code: ErrorCode, field: string, detail: string): AppError {
  return new AppError(409, code, detail, { fieldErrors: { [field]: [code] } });
}

// The customer a document is written for: a customer of this workspace, and not archived. A draft
// that already has this customer keeps it (keptId) even if the customer was archived since, like a
// customer keeps its archived price list (15a): the person can still finish the document. FOR
// SHARE: an archive or a delete waits until we commit.
export async function assertCustomer(
  tx: Transaction,
  customerId: string,
  keptId: string | null = null,
): Promise<PartyRef> {
  const [row] = await tx
    .select({
      id: parties.id,
      code: parties.code,
      name: parties.name,
      archivedAt: parties.archivedAt,
    })
    .from(parties)
    .where(
      and(
        eq(parties.tenantId, getTenantId()),
        eq(parties.id, customerId),
        eq(parties.isCustomer, true),
      ),
    )
    .for('share');
  if (!row || (row.archivedAt !== null && row.id !== keptId)) {
    throw fieldError('sales_customer_invalid', 'customerId', 'Pick an active customer.');
  }
  return { id: row.id, code: row.code, name: row.name };
}

// An address of this customer, and its text as the document keeps it: the label, the address and
// the phone on their own lines, the way a challan prints them. null = no address chosen.
export async function shippingAddressOf(
  tx: Transaction,
  customerId: string,
  addressId: string | null,
): Promise<{ id: string; text: string } | null> {
  if (addressId === null) return null;
  const [row] = await tx
    .select({
      label: partyAddresses.label,
      address: partyAddresses.address,
      phone: partyAddresses.phone,
    })
    .from(partyAddresses)
    .where(
      and(
        eq(partyAddresses.tenantId, getTenantId()),
        eq(partyAddresses.partyId, customerId),
        eq(partyAddresses.id, addressId),
      ),
    );
  if (!row) {
    throw fieldError(
      'sales_address_invalid',
      'shippingAddressId',
      'Pick one of this customer’s addresses.',
    );
  }
  const text = [row.label, row.address, row.phone]
    .filter((part): part is string => part !== null)
    .join('\n');
  return { id: addressId, text };
}

// The workspace setting now (step 15a). A new document copies it and keeps its copy: when the owner
// changes the setting, the prices on old documents still mean what they meant.
export async function pricesIncludeVatNow(tx: Transaction): Promise<boolean> {
  const [settings] = await tx
    .select({ pricesIncludeVat: tenantSettings.pricesIncludeVat })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, getTenantId()));
  if (!settings) throw new Error(`tenant_settings row missing for tenant ${getTenantId()}`);
  return settings.pricesIncludeVat;
}

// The parties of some documents, for the lists: id → code and name
export async function customerRefs(
  tx: Transaction,
  ids: readonly string[],
): Promise<Map<string, PartyRef>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({ id: parties.id, code: parties.code, name: parties.name })
    .from(parties)
    .where(and(eq(parties.tenantId, getTenantId()), inArray(parties.id, unique)));
  return new Map(rows.map((row) => [row.id, row]));
}

// The VAT rate a line used, as the line keeps it
export interface TaxRateSnapshot {
  id: string;
  name: string;
  kind: TaxRateKind;
  rate: string;
}

// A line checked against its product and its VAT rate, with its amounts worked out
export interface ResolvedSalesLine {
  variant: VariantInfo;
  unitId: string;
  quantity: string;
  factor: string;
  baseQuantity: string;
  description: string;
  unitPrice: string;
  discountType: SalesLineInput['discountType'];
  discount: string;
  taxRate: TaxRateSnapshot;
  amounts: LineAmounts;
}

// Every rule of a sales line the contract cannot check: the variant is an active product or
// service of this workspace, the unit is its base unit or one of its packs, the quantity fits the
// unit, and the VAT rate is an active one. keptRateIds: the rates the document's lines already use;
// they stay usable after the rate is archived, so an old draft can still be saved. All problems
// come back at once, each under its own field, like resolveLines() of the stock documents.
export async function resolveSalesLines(
  tx: Transaction,
  lines: readonly SalesLineInput[],
  pricesIncludeVat: boolean,
  keptRateIds: ReadonlySet<string> = new Set(),
): Promise<ResolvedSalesLine[]> {
  const variants = await loadVariants(
    tx,
    lines.map((line) => line.variantId),
  );
  const rateIds = [...new Set(lines.map((line) => line.taxRateId))];
  const rateRows = await tx
    .select({
      id: taxRates.id,
      name: taxRates.name,
      kind: taxRates.kind,
      rate: taxRates.rate,
      archivedAt: taxRates.archivedAt,
    })
    .from(taxRates)
    .where(and(eq(taxRates.tenantId, getTenantId()), inArray(taxRates.id, rateIds)));
  const rates = new Map(rateRows.map((row) => [row.id, row]));

  const issues: LineIssue[] = [];
  const resolved: ResolvedSalesLine[] = [];
  lines.forEach((line, index) => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: linePath(index, field), code });
    };
    // Unknown, another workspace's or archived: the same answer. A service is fine here: it is
    // sold, just never delivered.
    const variant = variants.get(line.variantId);
    if (variant === undefined || variant.archived) {
      at('variantId', 'sales_item_invalid');
      return;
    }
    const unit =
      line.unitId === variant.baseUnitId
        ? { factor: '1', decimals: variant.baseDecimals }
        : variant.units.find((pack) => pack.unitId === line.unitId);
    if (unit === undefined) {
      at('unitId', 'stock_unit_invalid');
      return;
    }
    if (!fitsDecimals(line.quantity, unit.decimals)) {
      at('quantity', 'stock_quantity_decimals');
      return;
    }
    const baseQuantity = toBaseQuantity(line.quantity, unit.factor, variant.baseDecimals);
    if (!isQuantity(baseQuantity)) {
      at('quantity', 'quantity_format');
      return;
    }
    const rate = rates.get(line.taxRateId);
    if (rate === undefined || (rate.archivedAt !== null && !keptRateIds.has(rate.id))) {
      at('taxRateId', 'tax_rate_invalid');
      return;
    }
    const taxRate = { id: rate.id, name: rate.name, kind: rate.kind, rate: rate.rate };
    resolved.push({
      variant,
      unitId: line.unitId,
      quantity: line.quantity,
      factor: unit.factor,
      baseQuantity,
      description: line.description ?? defaultLineDescription(variant),
      unitPrice: line.unitPrice,
      discountType: line.discountType,
      discount: line.discount,
      taxRate,
      // The same function the form totals with: the server stores what the person saw
      amounts: lineAmounts(
        {
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountType: line.discountType,
          discount: line.discount,
          rate: rate.rate,
        },
        pricesIncludeVat,
      ),
    });
  });
  if (issues.length > 0) throw linesError(issues);
  return resolved;
}

// The columns a quotation line and an order line share, for an insert
export function salesLineValues(line: ResolvedSalesLine, index: number) {
  return {
    tenantId: getTenantId(),
    lineNo: index + 1,
    productId: line.variant.productId,
    variantId: line.variant.variantId,
    unitId: line.unitId,
    quantity: line.quantity,
    factor: line.factor,
    baseQuantity: line.baseQuantity,
    description: line.description,
    unitPrice: line.unitPrice,
    discountType: line.discountType,
    discount: line.discount,
    taxRateId: line.taxRate.id,
    taxRateName: line.taxRate.name,
    taxRateKind: line.taxRate.kind,
    taxRate: line.taxRate.rate,
    net: line.amounts.net,
    vat: line.amounts.vat,
    total: line.amounts.total,
  };
}

// A stored quotation or order line as the API sends it
interface SalesLineRow {
  id: string;
  unitId: string;
  quantity: string;
  baseQuantity: string;
  description: string;
  unitPrice: string;
  discountType: SalesLineInput['discountType'];
  discount: string;
  taxRateId: string;
  taxRateName: string;
  taxRateKind: string;
  taxRate: string;
  net: string;
  vat: string;
  total: string;
}

export function toSalesLine(row: SalesLineRow, variant: VariantInfo): SalesLine {
  return {
    id: row.id,
    variantId: variant.variantId,
    productId: variant.productId,
    productCode: variant.productCode,
    productName: variant.productName,
    optionValues: variant.optionValues,
    sku: variant.sku,
    baseUnitId: variant.baseUnitId,
    productType: variant.type,
    tracking: variant.tracking,
    hasExpiry: variant.hasExpiry,
    units: variant.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
    unitId: row.unitId,
    quantity: row.quantity,
    baseQuantity: row.baseQuantity,
    description: row.description,
    unitPrice: row.unitPrice,
    discountType: row.discountType,
    discount: row.discount,
    taxRate: { id: row.taxRateId, name: row.taxRateName, kind: row.taxRateKind, rate: row.taxRate },
    net: row.net,
    vat: row.vat,
    total: row.total,
  };
}

// The lines of a document with their variants, in line order. The FK keeps a variant while a line
// points at it, so none is ever missing; flatMap only satisfies the Map's undefined.
export async function withVariants<TRow extends { variantId: string }>(
  tx: Transaction,
  rows: readonly TRow[],
): Promise<{ row: TRow; variant: VariantInfo }[]> {
  const variants = await loadVariants(
    tx,
    rows.map((row) => row.variantId),
  );
  return rows.flatMap((row) => {
    const variant = variants.get(row.variantId);
    return variant === undefined ? [] : [{ row, variant }];
  });
}
