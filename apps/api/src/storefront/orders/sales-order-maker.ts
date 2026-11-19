import { Injectable } from '@nestjs/common';
import {
  compareMoney,
  type CustomerInput,
  productInputSchema,
  type SalesLineInput,
  todayIn,
} from '@omnivo/contracts';
import {
  parties,
  products,
  productVariants,
  storefrontOrderLines,
  storefrontOrders,
  storefrontSettings,
  storefrontStockHolds,
  tenantSettings,
  units,
} from '@omnivo/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { audit, created } from '../../common/audit/audit.js';
import { AppError } from '../../common/http/app-error.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import { ProductsService } from '../../products/products.service.js';
import { CustomersService } from '../../sales/customers.service.js';
import { SalesOrdersService } from '../../sales/sales-orders.service.js';

type OrderRow = typeof storefrontOrders.$inferSelect;
type SettingsRow = typeof storefrontSettings.$inferSelect;

// A phone number as its 11 digits: "+880 1786-120356" and "01786 120356" are both 01786120356.
// The digits first, then a leading 880 (Bangladesh's country code) becomes the 0 it stands for.
// The shop keeps a phone in this form already (storefront_orders_phone_check); a customer's phone
// is typed by hand in the ERP, in any form
const phoneDigits = sql<string>`CASE
  WHEN regexp_replace(coalesce(${parties.phone}, ''), '[^0-9]', '', 'g') LIKE '880%'
  THEN '0' || substr(regexp_replace(${parties.phone}, '[^0-9]', '', 'g'), 4)
  ELSE regexp_replace(coalesce(${parties.phone}, ''), '[^0-9]', '', 'g') END`;

// A product's VAT rate: its own, or the workspace's default (a product with no rate follows the
// default, step 12). NULL when neither exists: the line is refused with tax_rate_invalid
const rateOf = sql<string | null>`coalesce(${products.taxRateId}, (
  SELECT t.id FROM tax_rates t
   WHERE t.tenant_id = ${products.tenantId} AND t.is_default AND t.archived_at IS NULL))`;

// The address on the sales order and the challan: who, where and the phone on their own lines, the
// way a customer's address prints (addressText in sales-lines.ts). The shopper's own for this
// order, which may not be any address the customer has saved
export function shippingText(order: Pick<OrderRow, 'customerName' | 'address' | 'phone'>) {
  return [order.customerName, order.address, order.phone].join('\n');
}

// Step 27b: a shop order's customer and sales order (decisions 1 to 4). One class for both
// callers: the confirm event's handler in the worker (no member, so no actor on what it writes),
// and "Make the sales order" on the order's page (a member, after the handler failed). The caller
// holds the shop order's row lock (FOR UPDATE), so the two never make two sales orders for one
// order, and passes its transaction: the customer, the "Delivery charge" service, the sales order
// and the order's link to it are written together or not at all.
@Injectable()
export class ShopSalesOrderMaker {
  constructor(
    private readonly customers: CustomersService,
    private readonly salesOrders: SalesOrdersService,
    private readonly products: ProductsService,
  ) {}

  // Returns the sales order's id. Refused (an AppError, with the sales order's own error code)
  // when a rule of the sales order says no: an archived product, a product without a VAT rate
  async make(tx: Transaction, order: OrderRow): Promise<string> {
    const tenantId = getTenantId();
    const [shop] = await tx
      .select()
      .from(storefrontSettings)
      .where(eq(storefrontSettings.tenantId, tenantId))
      // The lazy "Delivery charge" below: two orders confirmed at once take turns here, and the
      // second finds the service the first made, instead of making a second one
      .for('update');
    if (!shop) throw new Error(`Order ${order.id} has no shop settings`);
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    const today = todayIn(settings?.timezone ?? 'Asia/Dhaka');

    const customerId = await this.customerFor(tx, order, shop);
    const lines = await this.goodsLines(tx, order);
    // A free delivery adds no line: a line of ৳0 would print a service nobody paid for
    if (compareMoney(order.deliveryCharge, '0') > 0) {
      lines.push(await this.deliveryLine(tx, shop, order.deliveryCharge));
    }
    const salesOrderId = await this.salesOrders.createForShop(
      tx,
      {
        customerId,
        date: today,
        deliveryDate: null,
        // The shop's number on the sales order, as a buyer's PO number would be: the order's page
        // and the lists show "Their reference W-000123"
        customerReference: order.orderNo,
        warehouseId: await this.warehouseOf(tx, order, shop),
        shippingAddressId: null,
        note: null,
        lines,
      },
      shippingText(order),
    );
    // The link and the error together, in one UPDATE: storefront_orders_document_error_check
    // allows an error only while there is no sales order
    await tx
      .update(storefrontOrders)
      .set({
        salesOrderId,
        documentError: null,
        version: sql`${storefrontOrders.version} + 1`,
      })
      .where(and(eq(storefrontOrders.tenantId, tenantId), eq(storefrontOrders.id, order.id)));
    await audit(tx, {
      action: 'storefront_order.sales_order_made',
      entityType: 'storefront_order',
      entityId: order.id,
      // The sales order's own rows say the rest (its customer, its lines); this one ties them to
      // the shop's number
      changes: created({ order: order.orderNo }),
    });
    return salesOrderId;
  }

  // Decision 2: the oldest active customer with this phone, else a new one. Archived customers
  // are left out: their documents are closed, and a new sale on one would bring it back unseen
  private async customerFor(tx: Transaction, order: OrderRow, shop: SettingsRow): Promise<string> {
    const [found] = await tx
      .select({ id: parties.id })
      .from(parties)
      .where(
        and(
          eq(parties.tenantId, getTenantId()),
          eq(parties.isCustomer, true),
          isNull(parties.archivedAt),
          sql`${phoneDigits} = ${order.phone}`,
        ),
      )
      .orderBy(asc(parties.createdAt), asc(parties.id))
      .limit(1);
    if (found) return found.id;
    const input: CustomerInput = {
      // The next number from the 'sales.customer' series, like the form's empty box
      code: null,
      name: order.customerName,
      groupId: null,
      contactPerson: null,
      phone: order.phone,
      email: null,
      // The language the shopper used the shop in: their invoices and SMS speak it too
      documentLanguage: shop.language,
      bin: null,
      paymentTermsDays: 0,
      // No limit (decision 2): a limit is a decision about someone the company knows
      creditLimit: null,
      priceListId: null,
      notes: null,
      // Saved for the next time staff write them a document by hand
      addresses: [{ id: null, kind: 'shipping', label: null, address: order.address, phone: null }],
    };
    return this.customers.createForShop(tx, input);
  }

  // One sales order line per shop line, in the cart's order (its line number = the position), in
  // the product's base unit at the shop's unit price (decision 3). No line discount: the shop's
  // price is already what the shopper pays
  private async goodsLines(tx: Transaction, order: OrderRow): Promise<SalesLineInput[]> {
    const rows = await tx
      .select({
        variantId: storefrontOrderLines.variantId,
        quantity: storefrontOrderLines.quantity,
        unitPrice: storefrontOrderLines.unitPrice,
        unitId: products.baseUnitId,
        taxRateId: rateOf,
      })
      .from(storefrontOrderLines)
      .innerJoin(
        products,
        and(
          eq(products.tenantId, storefrontOrderLines.tenantId),
          eq(products.id, storefrontOrderLines.productId),
        ),
      )
      .where(
        and(
          eq(storefrontOrderLines.tenantId, getTenantId()),
          eq(storefrontOrderLines.orderId, order.id),
        ),
      )
      .orderBy(asc(storefrontOrderLines.position));
    return rows.map((row) => ({
      variantId: row.variantId,
      unitId: row.unitId,
      quantity: String(row.quantity),
      // null: the product's name and its variant's options, as on any sales order
      description: null,
      unitPrice: row.unitPrice,
      discountType: 'amount',
      discount: '0',
      taxRateId: requireRate(row.taxRateId),
    }));
  }

  // The delivery charge as one service line (decision 4): the service the shop's settings name,
  // or "Delivery charge", made now and kept in the settings
  private async deliveryLine(
    tx: Transaction,
    shop: SettingsRow,
    charge: string,
  ): Promise<SalesLineInput> {
    const variantId = shop.deliveryVariantId ?? (await this.makeDeliveryService(tx));
    const [row] = await tx
      .select({ unitId: products.baseUnitId, taxRateId: rateOf })
      .from(productVariants)
      .innerJoin(
        products,
        and(
          eq(products.tenantId, productVariants.tenantId),
          eq(products.id, productVariants.productId),
        ),
      )
      .where(and(eq(productVariants.tenantId, getTenantId()), eq(productVariants.id, variantId)));
    if (!row) throw new Error(`Delivery charge variant ${variantId} is missing`);
    return {
      variantId,
      unitId: row.unitId,
      quantity: '1',
      description: null,
      unitPrice: charge,
      discountType: 'amount',
      discount: '0',
      taxRateId: requireRate(row.taxRateId),
    };
  }

  // A service in the workspace's piece unit, with the default VAT rate (a null rate follows the
  // default), and its ids in the shop's settings. The settings row is locked (make() above)
  private async makeDeliveryService(tx: Transaction): Promise<string> {
    const tenantId = getTenantId();
    // A count unit of one piece, "pcs" first. A workspace that deleted every such unit gets the
    // error that sends someone to the Shop settings' select, where any service can be picked
    const [unit] = await tx
      .select({ id: units.id })
      .from(units)
      .where(
        and(
          eq(units.tenantId, tenantId),
          isNull(units.archivedAt),
          eq(units.dimension, 'count'),
          sql`${units.ratio} = 1`,
        ),
      )
      .orderBy(sql`lower(${units.code}) = 'pcs' DESC`, asc(units.createdAt))
      .limit(1);
    if (!unit) {
      throw new AppError(
        409,
        'storefront_delivery_product_invalid',
        'No piece unit for the Delivery charge service. Pick a service in the shop settings.',
      );
    }
    const product = await this.products.createIn(
      tx,
      // parse: the form's own rules and defaults, so this product is one the form could have saved
      productInputSchema.parse({
        code: '',
        // Data, not a screen's words: it prints on the sales documents in the company's language
        // like any product name, and staff may rename it
        name: 'Delivery charge',
        type: 'service',
        categoryId: '',
        description: '',
        baseUnitId: unit.id,
        salesUnitId: '',
        purchaseUnitId: '',
        tracking: 'none',
        hasExpiry: false,
        taxRateId: '',
        options: [],
        variants: [
          { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
        ],
        units: [],
        customFields: {},
      }),
    );
    const [variant] = product.variants;
    if (!variant) throw new Error('Delivery charge was made without a variant');
    // Both columns at once: storefront_settings_delivery_check wants both or neither
    await tx
      .update(storefrontSettings)
      .set({
        deliveryProductId: product.id,
        deliveryVariantId: variant.id,
        // A settings form open somewhere still says "Made on the first order": its save must
        // reload first (version_conflict), not send the empty box back over this one
        version: sql`${storefrontSettings.version} + 1`,
      })
      .where(eq(storefrontSettings.tenantId, tenantId));
    return variant.id;
  }

  // The warehouse the order's stock is held in (27a copied the shop's warehouse onto each hold
  // when the order was placed). The shop's warehouse now only when the holds are gone, which a
  // confirmed order never is before it is packed
  private async warehouseOf(tx: Transaction, order: OrderRow, shop: SettingsRow): Promise<string> {
    const [hold] = await tx
      .select({ warehouseId: storefrontStockHolds.warehouseId })
      .from(storefrontStockHolds)
      .where(
        and(
          eq(storefrontStockHolds.tenantId, getTenantId()),
          eq(storefrontStockHolds.orderId, order.id),
        ),
      )
      .limit(1);
    const warehouseId = hold?.warehouseId ?? shop.defaultWarehouseId;
    if (warehouseId === null) throw new Error(`Order ${order.id} has no warehouse`);
    return warehouseId;
  }
}

// A product with no rate of its own in a workspace with no default rate: the sales order's own
// error for a line without a valid rate, so the order page says what to fix
function requireRate(taxRateId: string | null): string {
  if (taxRateId === null) {
    throw new AppError(409, 'tax_rate_invalid', 'Set a default VAT rate, or one on the product.');
  }
  return taxRateId;
}
