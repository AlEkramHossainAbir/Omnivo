import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  addMoney,
  type CreateStorefrontSettingsInput,
  defaultLineDescription,
  type ShopDeliveryZone,
  type ShopPaymentMethod,
  type StorefrontReadiness,
  type StorefrontSettings,
  type StorefrontSetup,
  storefrontSubdomainSchema,
  type UpdateStorefrontSettingsInput,
} from '@omnivo/contracts';
import {
  products,
  productVariants,
  storefrontSettings,
  tenants,
  tenantSettings,
  warehouses,
} from '@omnivo/db';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';

import { audit, created, diff } from '../../common/audit/audit.js';
import { isUniqueViolation } from '../../common/db/pg-errors.js';
import { AppError, versionConflict } from '../../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import type { Config } from '../../config.js';
import { CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { onlineReady } from '../online-ready.js';
import { shopUrl } from '../shop-url.js';

type SettingsRow = typeof storefrontSettings.$inferSelect;
type SettingsInput = CreateStorefrontSettingsInput;

function subdomainTaken(): AppError {
  return new AppError(409, 'storefront_subdomain_taken', 'Another shop has this address.', {
    fieldErrors: { subdomain: ['storefront_subdomain_taken'] },
  });
}

function warehouseInvalid(): AppError {
  return new AppError(409, 'storefront_warehouse_invalid', 'Pick an active warehouse.', {
    fieldErrors: { defaultWarehouseId: ['storefront_warehouse_invalid'] },
  });
}

// Step 27b: the delivery charge's service (decisions 4 and 17), said on its select
function deliveryError(
  code: 'storefront_delivery_product_invalid' | 'storefront_delivery_product_required',
) {
  return new AppError(409, code, 'Pick an active service for the delivery charge.', {
    fieldErrors: { deliveryVariantId: [code] },
  });
}

export function notSetUp(): AppError {
  return new AppError(409, 'storefront_not_set_up', 'Save the shop settings first.');
}

// A new zone's id: what a shopper's cart keeps (decision 13). Random, not made from the name: a
// Bangla name has no Latin letter, and two zones renamed into each other's names must not swap
// carts. 8 hex characters in a list of six never collide in practice; the loop makes sure
function zoneIds(input: SettingsInput['deliveryZones'], before: readonly ShopDeliveryZone[]) {
  const saved = new Set(before.map((zone) => zone.id));
  const used = new Set<string>();
  return input.map((zone): ShopDeliveryZone => {
    // A saved zone keeps its id. An id the shop never had (a stale form, a hand-made request) is
    // a new zone, and an id sent twice is kept once: two radio cards with one value would be one
    let id = zone.id !== null && saved.has(zone.id) && !used.has(zone.id) ? zone.id : null;
    while (id === null || used.has(id)) id = `zone-${randomBytes(4).toString('hex')}`;
    used.add(id);
    // 4 decimals, as Postgres keeps every other amount, so the quote compares like with like
    return { id, name: zone.name, charge: addMoney(zone.charge, '0') };
  });
}

// What the table keeps, from the form. The name in NFC (26f, decision 34): the shop's search folds
// to NFC, so a Bangla word typed in its other form would miss. Step 27b: the delivery charge's
// service as both its ids, which checkDelivery() looked up (the table's FK names the pair)
function columnsOf(
  input: SettingsInput,
  before: readonly ShopDeliveryZone[],
  delivery: { productId: string; variantId: string } | null,
) {
  return {
    subdomain: input.subdomain,
    name: input.name.normalize('NFC'),
    language: input.language,
    hotline: input.hotline,
    address: input.address,
    facebookUrl: input.facebookUrl,
    instagramUrl: input.instagramUrl,
    xUrl: input.xUrl,
    linkedinUrl: input.linkedinUrl,
    defaultWarehouseId: input.defaultWarehouseId,
    deliveryZones: zoneIds(input.deliveryZones, before),
    freeDeliveryFrom: input.freeDeliveryFrom,
    minimumOrder: input.minimumOrder,
    paymentMethods: input.paymentMethods,
    deliveryProductId: delivery?.productId ?? null,
    deliveryVariantId: delivery?.variantId ?? null,
  };
}

// The audit's view of the settings: plain values only (AuditValue), so the lists become text.
// Each amount as Postgres writes it, so "1000" and "1000.0000" are not a change
function snapshot(row: SettingsRow) {
  const money = (value: string | null) => (value === null ? null : addMoney(value, '0'));
  return {
    subdomain: row.subdomain,
    name: row.name,
    language: row.language,
    hotline: row.hotline,
    address: row.address,
    facebookUrl: row.facebookUrl,
    instagramUrl: row.instagramUrl,
    xUrl: row.xUrl,
    linkedinUrl: row.linkedinUrl,
    defaultWarehouseId: row.defaultWarehouseId,
    deliveryZones: row.deliveryZones
      .map((zone) => `${zone.name} ${addMoney(zone.charge, '0')}`)
      .join(', '),
    freeDeliveryFrom: money(row.freeDeliveryFrom),
    minimumOrder: money(row.minimumOrder),
    paymentMethods: row.paymentMethods.join(', '),
    deliveryVariantId: row.deliveryVariantId,
  };
}

// Step 27d (decision 4): Pay online can be newly ticked only while the gateway is ready. One that
// was ticked already and is not ready now (an account archived since) stays as it is: the checkout
// hides it by itself (offeredMethods), and a save of the shop's other settings is not refused for it
async function checkOnline(
  tx: Transaction,
  methods: readonly ShopPaymentMethod[],
  before: readonly ShopPaymentMethod[],
): Promise<void> {
  if (!methods.includes('online') || before.includes('online')) return;
  if (await onlineReady(tx)) return;
  throw new AppError(
    422,
    'storefront_online_not_ready',
    'Save the payment gateway with its two accounts first.',
    { fieldErrors: { paymentMethods: ['storefront_online_not_ready'] } },
  );
}

// Step 26g: the shop's settings and its launch (decision 1). One row per workspace: the first
// save makes it (POST), later saves change it (PUT, with the version), and "Open the shop" sets
// launched_at once. Nothing here closes a shop again (step 26e: a shop is always open).
@Injectable()
export class StorefrontSettingsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  setup(): Promise<StorefrontSetup> {
    return this.withTenant(async (tx) => {
      const row = await this.find(tx, false);
      const [company] = await tx
        .select({
          slug: tenants.slug,
          name: tenants.name,
          phone: tenantSettings.phone,
          address: tenantSettings.address,
        })
        .from(tenants)
        .leftJoin(tenantSettings, eq(tenantSettings.tenantId, tenants.id))
        .where(eq(tenants.id, getTenantId()));
      // Decision 18: the workspace's slug when it can be a subdomain at all. Whether another
      // shop has it is a question about other workspaces, which this transaction cannot see
      // (RLS); the first save answers it (storefront_subdomain_taken). Workspace slugs are
      // unique, and shops start from them, so a clash is rare
      const slug = company?.slug ?? '';
      return {
        baseDomain: this.config.storefront.baseDomain,
        shop: row === null ? null : await this.toSettings(tx, row),
        deliveryChoices: await this.deliveryChoices(tx, row?.deliveryVariantId ?? null),
        suggested: {
          subdomain: storefrontSubdomainSchema.safeParse(slug).success ? slug : '',
          name: company?.name ?? '',
          hotline: company?.phone ?? '',
          address: company?.address ?? '',
        },
      };
    });
  }

  async create(input: CreateStorefrontSettingsInput): Promise<StorefrontSettings> {
    try {
      return await this.withTenant(async (tx) => {
        await this.checkWarehouse(tx, input.defaultWarehouseId);
        const delivery = await this.checkDelivery(tx, input.deliveryVariantId, null);
        await checkOnline(tx, input.paymentMethods, []);
        const [row] = await tx
          .insert(storefrontSettings)
          .values({
            tenantId: getTenantId(),
            ...columnsOf(input, [], delivery),
            updatedBy: currentPrincipal().userId,
          })
          // A second first save (two tabs, a double click): the row is there already. Not an
          // upsert: that would overwrite the other tab's save without its version
          .onConflictDoNothing({ target: storefrontSettings.tenantId })
          .returning();
        if (!row) {
          throw new AppError(409, 'storefront_set_up_already', 'The shop is set up already.');
        }
        await audit(tx, {
          action: 'storefront.created',
          entityType: 'storefront',
          entityId: row.tenantId,
          changes: created(snapshot(row)),
        });
        return this.toSettings(tx, row);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'storefront_settings_subdomain_idx')) throw subdomainTaken();
      throw error;
    }
  }

  async update(input: UpdateStorefrontSettingsInput): Promise<StorefrontSettings> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.find(tx, true);
        if (before === null) throw notSetUp();
        if (before.version !== input.version) throw versionConflict();
        // A launched shop counts its stock somewhere and delivers somewhere (the table's
        // storefront_settings_launch_check); said on the boxes, not as a database error
        if (before.launchedAt !== null) {
          if (input.defaultWarehouseId === null) throw warehouseInvalid();
          if (input.deliveryZones.length === 0) {
            throw new AppError(409, 'too_short', 'An open shop needs a delivery zone.', {
              fieldErrors: { deliveryZones: ['too_short'] },
            });
          }
        }
        // Only a new warehouse is checked: the saved one may have been archived since, and the
        // shop keeps counting there until someone picks another
        if (input.defaultWarehouseId !== before.defaultWarehouseId) {
          await this.checkWarehouse(tx, input.defaultWarehouseId);
        }
        const delivery = await this.checkDelivery(tx, input.deliveryVariantId, before);
        await checkOnline(tx, input.paymentMethods, before.paymentMethods);
        const [after] = await tx
          .update(storefrontSettings)
          .set({
            ...columnsOf(input, before.deliveryZones, delivery),
            version: sql`${storefrontSettings.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(eq(storefrontSettings.tenantId, getTenantId()))
          .returning();
        if (!after) throw notSetUp();
        await audit(tx, {
          action: 'storefront.updated',
          entityType: 'storefront',
          entityId: after.tenantId,
          changes: diff(snapshot(before), snapshot(after)),
        });
        return this.toSettings(tx, after);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'storefront_settings_subdomain_idx')) throw subdomainTaken();
      throw error;
    }
  }

  launch(version: number): Promise<StorefrontSettings> {
    return this.withTenant(async (tx) => {
      const before = await this.find(tx, true);
      if (before === null) throw notSetUp();
      if (before.version !== version) throw versionConflict();
      // A second click, or two tabs: open already, which is what both wanted
      if (before.launchedAt !== null) return this.toSettings(tx, before);
      const readiness = await this.readiness(tx, before);
      if (!readiness.warehouse || !readiness.zone || !readiness.listing) {
        throw new AppError(
          409,
          'storefront_launch_not_ready',
          'The shop needs a warehouse, a delivery zone and a published listing first.',
        );
      }
      const [after] = await tx
        .update(storefrontSettings)
        .set({
          launchedAt: new Date(),
          version: sql`${storefrontSettings.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(eq(storefrontSettings.tenantId, getTenantId()))
        .returning();
      if (!after) throw notSetUp();
      await audit(tx, {
        action: 'storefront.launched',
        entityType: 'storefront',
        entityId: after.tenantId,
        changes: diff({ launched: false }, { launched: true }),
      });
      return this.toSettings(tx, after);
    });
  }

  // The shop's row; null before the first save. Also what the catalog reads for its warehouse
  // and the listings' shop addresses
  async find(tx: Transaction, forUpdate: boolean): Promise<SettingsRow | null> {
    const query = tx
      .select()
      .from(storefrontSettings)
      .where(eq(storefrontSettings.tenantId, getTenantId()));
    const [row] = forUpdate ? await query.for('update') : await query;
    return row ?? null;
  }

  // null is allowed before the launch ("Pick a warehouse"); otherwise an active warehouse of
  // this workspace. The FK checks the workspace too, but its error would name no box
  private async checkWarehouse(tx: Transaction, warehouseId: string | null): Promise<void> {
    if (warehouseId === null) return;
    const [found] = await tx
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(
        and(
          eq(warehouses.tenantId, getTenantId()),
          eq(warehouses.id, warehouseId),
          isNull(warehouses.archivedAt),
        ),
      );
    if (!found) throw warehouseInvalid();
  }

  // Step 27b: the delivery charge's service, as both ids. A new choice must be an active service
  // of this workspace; the saved one is kept even if it was archived since (like the warehouse:
  // the next shop order's sales order then says so, and someone picks another). Emptied again
  // (decision 17): refused once a shop order's sales order has a line of the saved one, or the
  // next order would make a second "Delivery charge"
  private async checkDelivery(
    tx: Transaction,
    variantId: string | null,
    before: SettingsRow | null,
  ): Promise<{ productId: string; variantId: string } | null> {
    const tenantId = getTenantId();
    const saved = before?.deliveryVariantId ?? null;
    if (variantId === null) {
      if (saved === null) return null;
      const used = await tx.execute(sql`
        SELECT 1 FROM storefront_orders o
          JOIN sales_order_lines l ON l.tenant_id = o.tenant_id AND l.order_id = o.sales_order_id
         WHERE o.tenant_id = ${tenantId}::uuid AND l.variant_id = ${saved}::uuid
         LIMIT 1`);
      if (used.length > 0) throw deliveryError('storefront_delivery_product_required');
      return null;
    }
    const [found] = await tx
      .select({
        productId: products.id,
        type: products.type,
        archived: sql<boolean>`
        ${products.archivedAt} IS NOT NULL OR ${productVariants.archivedAt} IS NOT NULL`,
      })
      .from(productVariants)
      .innerJoin(
        products,
        and(
          eq(products.tenantId, productVariants.tenantId),
          eq(products.id, productVariants.productId),
        ),
      )
      .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.id, variantId)));
    if (!found) throw deliveryError('storefront_delivery_product_invalid');
    if (variantId !== saved && (found.type !== 'service' || found.archived)) {
      throw deliveryError('storefront_delivery_product_invalid');
    }
    return { productId: found.productId, variantId };
  }

  // What the select offers (decision 17): the active services, by name, and the saved one even
  // when it was archived since, so the select can still show what is saved. 200 at most: a
  // workspace has a few services, not thousands
  private async deliveryChoices(
    tx: Transaction,
    saved: string | null,
  ): Promise<StorefrontSetup['deliveryChoices']> {
    const rows = await tx
      .select({
        variantId: productVariants.id,
        productName: products.name,
        optionValues: productVariants.optionValues,
        sku: productVariants.sku,
      })
      .from(productVariants)
      .innerJoin(
        products,
        and(
          eq(products.tenantId, productVariants.tenantId),
          eq(products.id, productVariants.productId),
        ),
      )
      .where(
        and(
          eq(productVariants.tenantId, getTenantId()),
          or(
            and(
              eq(products.type, 'service'),
              isNull(products.archivedAt),
              isNull(productVariants.archivedAt),
            ),
            saved === null ? undefined : eq(productVariants.id, saved),
          ),
        ),
      )
      .orderBy(asc(sql`lower(${products.name})`), asc(productVariants.sku))
      .limit(200);
    return rows.map((row) => ({
      variantId: row.variantId,
      name: defaultLineDescription(row),
      sku: row.sku,
    }));
  }

  // The launch checklist. The warehouse must still be active (one archived since the save would
  // show every listing out of stock), and "a published listing" is one the shop would show: its
  // product and variant not archived
  private async readiness(tx: Transaction, row: SettingsRow): Promise<StorefrontReadiness> {
    const tenantId = getTenantId();
    const [warehouse] =
      row.defaultWarehouseId === null
        ? []
        : await tx
            .select({ id: warehouses.id })
            .from(warehouses)
            .where(
              and(
                eq(warehouses.tenantId, tenantId),
                eq(warehouses.id, row.defaultWarehouseId),
                isNull(warehouses.archivedAt),
              ),
            );
    const listing = await tx.execute(sql`
      SELECT 1 FROM storefront_listings l
        JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
        JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
       WHERE l.tenant_id = ${tenantId}::uuid AND l.published_at IS NOT NULL
         AND v.archived_at IS NULL AND p.archived_at IS NULL
       LIMIT 1`);
    return {
      warehouse: warehouse !== undefined,
      zone: row.deliveryZones.length > 0,
      listing: listing.length > 0,
    };
  }

  private async toSettings(tx: Transaction, row: SettingsRow): Promise<StorefrontSettings> {
    return {
      subdomain: row.subdomain,
      shopUrl: shopUrl(this.config.storefront, row.subdomain),
      name: row.name,
      language: row.language,
      hotline: row.hotline,
      address: row.address,
      facebookUrl: row.facebookUrl,
      instagramUrl: row.instagramUrl,
      xUrl: row.xUrl,
      linkedinUrl: row.linkedinUrl,
      defaultWarehouseId: row.defaultWarehouseId,
      deliveryZones: row.deliveryZones,
      freeDeliveryFrom: row.freeDeliveryFrom,
      minimumOrder: row.minimumOrder,
      paymentMethods: row.paymentMethods,
      deliveryVariantId: row.deliveryVariantId,
      launchedAt: row.launchedAt?.toISOString() ?? null,
      readiness: await this.readiness(tx, row),
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
