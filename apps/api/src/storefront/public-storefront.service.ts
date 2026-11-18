import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_SETTINGS,
  listingQueryFromParams,
  renderSections,
  sectionsSummary,
  SHOP_GALLERY_MAX,
  SHOP_TEXT_PAGES,
  shopDeliveryZoneSchema,
  type PublicListingParams,
  type PublicShop,
  type ShopCartQuote,
  type ShopCartQuoteRequest,
  type ShopCategory,
  type ShopCheckoutSettings,
  type ShopCollection,
  type HeroBanner,
  type ShopHome,
  type ShopHomeBlock,
  type ShopListingPage,
  type ShopPaymentMethod,
  type ShopProductPage,
  type ShopTextPage,
  type ShopTextPageSlug,
  type StorefrontImage,
  storefrontImageSchema,
} from '@omnivo/contracts';
import {
  storefrontBanners,
  storefrontCategories,
  storefrontCollectionItems,
  storefrontCollections,
  storefrontHomeBlocks,
  storefrontPages,
  storefrontSettings,
  tenantSettings,
} from '@omnivo/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { notFound } from '../common/http/app-error.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';
import {
  idIn,
  listingOf,
  listingPage,
  type ListingRow,
  listingWith,
  selectListings,
} from './listing-sql.js';
import { shopImage, type StorefrontImageSize } from './media.js';
import { quoteCart, type QuotedListing } from './quote.js';
import { ShopDb, type ShopScope, storefrontNotFound } from './shop-db.js';

type BannerRow = typeof storefrontBanners.$inferSelect;

// A collection row on the home page shows at most this many cards. The row scrolls a page at a
// time; more than this is a category page, and the tenant links to one with a banner
const COLLECTION_MAX = 24;
// "Related Products" (shopProductPageSchema.related.max(12))
const RELATED_MAX = 12;
// The cart's ids are uuids. Anything else is a listing that cannot exist, and must not reach a
// ::uuid cast (a 500)
const uuidSchema = z.uuid();

// Step 26f: the eight answers of /public/v1. Every one runs inside ShopDb.read, as omnivo_public in
// the shop's workspace, and answers in the contract's shapes (storefront.ts), so the shop's pages
// are the same whether their data comes from the mock or from here.
@Injectable()
export class PublicStorefrontService {
  private readonly mediaUrl: string;

  constructor(
    private readonly shopDb: ShopDb,
    @Inject(CONFIG) config: Config,
  ) {
    this.mediaUrl = config.storefront.mediaUrl;
  }

  shop(host: string | undefined): Promise<PublicShop> {
    return this.shopDb.read(host, async (tx, shop) => {
      const [settings] = await tx
        .select()
        .from(storefrontSettings)
        .where(eq(storefrontSettings.tenantId, shop.tenantId));
      if (settings === undefined) throw storefrontNotFound();
      const [workspace] = await tx
        .select({ timezone: tenantSettings.timezone })
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, shop.tenantId));
      // Step 26h: the pages the tenant has written, so the footer links only those
      const written = await tx
        .select({ slug: storefrontPages.slug })
        .from(storefrontPages)
        .where(eq(storefrontPages.tenantId, shop.tenantId));
      const slugs = new Set(written.map((page) => page.slug));
      return {
        name: settings.name,
        // The logo's alt text is the shop's name: it is what the logo says
        logo:
          settings.logoImageId === null
            ? null
            : shopImage(this.mediaUrl, { id: settings.logoImageId, alt: settings.name }, 'small'),
        language: settings.language,
        theme: { brand: settings.brandColor, accent: settings.accentColor },
        hotline: settings.hotline,
        // A workspace has its settings row from its first day; the default is only for TypeScript
        timeZone: workspace?.timezone ?? DEFAULT_SETTINGS.timezone,
        address: settings.address,
        social: {
          facebook: settings.facebookUrl,
          instagram: settings.instagramUrl,
          x: settings.xUrl,
          linkedin: settings.linkedinUrl,
        },
        // In the footer's order (SHOP_TEXT_PAGES), not the table's: rows come back in any order
        pages: SHOP_TEXT_PAGES.filter((slug) => slugs.has(slug)),
      };
    });
  }

  categories(host: string | undefined): Promise<ShopCategory[]> {
    return this.shopDb.read(host, (tx, shop) => categoriesOf(tx, shop));
  }

  listings(host: string | undefined, params: PublicListingParams): Promise<ShopListingPage> {
    return this.shopDb.read(host, async (tx, shop) =>
      listingPage(
        tx,
        shop,
        listingQueryFromParams(params),
        await categoriesOf(tx, shop),
        this.mediaUrl,
      ),
    );
  }

  home(host: string | undefined): Promise<ShopHome> {
    return this.shopDb.read(host, async (tx, shop) => {
      const banners = await tx
        .select()
        .from(storefrontBanners)
        .where(eq(storefrontBanners.tenantId, shop.tenantId));
      const hero = banners.find((banner) => banner.kind === 'hero');

      // Decision 18: the grid is the first page of /c/all, so "Load More" under it continues
      // exactly where it stops
      const featured = await listingPage(
        tx,
        shop,
        listingQueryFromParams({}),
        await categoriesOf(tx, shop),
        this.mediaUrl,
      );

      return {
        // The 26f.3 decision: no hero is a home page without one, never an error
        hero: hero === undefined ? null : this.heroOf(hero),
        featured: featured.items,
        hasMoreFeatured: featured.nextCursor !== null,
        blocks: await this.blocks(tx, shop, banners),
      };
    });
  }

  product(host: string | undefined, slug: string): Promise<ShopProductPage> {
    return this.shopDb.read(host, async (tx, shop) => {
      const [row] = await selectListings(tx, shop, sql`WHERE shown.slug = ${slug}`);
      if (row === undefined) throw notFound('Product');
      const related = await selectListings(
        tx,
        shop,
        sql`WHERE shown.category_id = ${row.category_id}::uuid AND shown.id <> ${row.id}::uuid
            ORDER BY shown.published_at DESC, shown.id DESC
            LIMIT ${RELATED_MAX}`,
      );
      return {
        product: {
          // The gallery's photos, large; the database keeps at most four (SHOP_GALLERY_MAX)
          ...listingWith(
            row,
            shop,
            row.images.slice(0, SHOP_GALLERY_MAX).map((image) => this.image(image, 'large')),
          ),
          sku: row.sku === null || row.sku === '' ? null : row.sku,
          unitName: row.unit_name,
          descriptionHtml: renderSections(row.description_sections),
          // Decision 14: the API decides, so the shop never does. The name is cut to the
          // contract's 120 characters; the tenant's own SEO title is already that short (0063)
          seo: {
            title: row.seo_title ?? row.name.slice(0, 120),
            description: row.seo_description ?? sectionsSummary(row.description_sections),
          },
        },
        related: related.map((listing) => listingOf(listing, shop, this.mediaUrl)),
      };
    });
  }

  quote(host: string | undefined, request: ShopCartQuoteRequest): Promise<ShopCartQuote> {
    return this.shopDb.read(host, async (tx, shop) => {
      const listings = await quotedListings(tx, shop, request.lines, this.mediaUrl);
      return quoteCart(request, listings, await checkoutSettingsOf(tx, shop));
    });
  }

  checkoutSettings(host: string | undefined): Promise<ShopCheckoutSettings> {
    return this.shopDb.read(host, (tx, shop) => checkoutSettingsOf(tx, shop));
  }

  textPage(host: string | undefined, slug: ShopTextPageSlug): Promise<ShopTextPage> {
    return this.shopDb.read(host, async (tx, shop) => {
      const [page] = await tx
        .select({ sections: storefrontPages.sections, updatedAt: storefrontPages.updatedAt })
        .from(storefrontPages)
        .where(and(eq(storefrontPages.tenantId, shop.tenantId), eq(storefrontPages.slug, slug)));
      // A page the tenant has not written is not there (the shop's "page not found")
      if (page === undefined) throw notFound('Page');
      return {
        slug,
        html: renderSections(page.sections),
        updatedAt: page.updatedAt.toISOString(),
      };
    });
  }

  // The banners and collections under the grid, in the tenant's order (shopHomeSchema.blocks)
  private async blocks(
    tx: Transaction,
    shop: ShopScope,
    banners: BannerRow[],
  ): Promise<ShopHomeBlock[]> {
    const blocks = await tx
      .select()
      .from(storefrontHomeBlocks)
      .where(eq(storefrontHomeBlocks.tenantId, shop.tenantId))
      .orderBy(asc(storefrontHomeBlocks.position));
    const collections = await this.collections(tx, shop);
    const bannerById = new Map(banners.map((banner) => [banner.id, banner]));

    return blocks.flatMap((block): ShopHomeBlock[] => {
      if (block.bannerId !== null) {
        const banner = bannerById.get(block.bannerId);
        // Decision 21: the hero has its own place at the top. A hero put in the blocks as well
        // (the database cannot refuse it) is left out here, so it never shows twice
        if (banner?.kind !== 'image') return [];
        return [
          {
            id: banner.id,
            kind: 'image',
            href: banner.href,
            desktopImage: this.image(banner.desktopImage, 'wide'),
            phoneImage: this.image(banner.phoneImage, 'large'),
          },
        ];
      }
      const collection =
        block.collectionId === null ? undefined : collections.get(block.collectionId);
      // A row whose listings are all hidden now (unpublished, archived, no price) is left out:
      // a collection has at least one card (shopCollectionSchema)
      return collection === undefined ? [] : [{ kind: 'collection', collection }];
    });
  }

  // Every collection with the cards it shows now, in its order. A listing the shop does not show
  // is simply not in `shown`, so the join leaves it out of its row (0064's comment)
  private async collections(
    tx: Transaction,
    shop: ShopScope,
  ): Promise<Map<string, ShopCollection>> {
    const heads = await tx
      .select()
      .from(storefrontCollections)
      .where(eq(storefrontCollections.tenantId, shop.tenantId));
    const items = await tx
      .select({
        collectionId: storefrontCollectionItems.collectionId,
        listingId: storefrontCollectionItems.listingId,
      })
      .from(storefrontCollectionItems)
      .where(eq(storefrontCollectionItems.tenantId, shop.tenantId))
      .orderBy(
        asc(storefrontCollectionItems.collectionId),
        asc(storefrontCollectionItems.position),
      );
    const ids = [...new Set(items.map((item) => item.listingId))];
    const rows = await selectListings(tx, shop, sql`WHERE ${idIn(sql`shown.id`, ids)}`);
    const cards = new Map(rows.map((row) => [row.id, listingOf(row, shop, this.mediaUrl)]));

    const result = new Map<string, ShopCollection>();
    for (const head of heads) {
      const listings = items
        .filter((item) => item.collectionId === head.id)
        .flatMap((item) => {
          const card = cards.get(item.listingId);
          return card === undefined ? [] : [card];
        })
        .slice(0, COLLECTION_MAX);
      if (listings.length > 0) {
        result.set(head.id, { id: head.id, title: head.title, icon: head.icon, listings });
      }
    }
    return result;
  }

  // The hero's words and colours are there whenever kind is 'hero' (storefront_banners_hero_check);
  // the checks below are what lets TypeScript know it. A row that breaks it shows no hero
  private heroOf(banner: BannerRow): HeroBanner | null {
    const { headline, buttonLabel, backgroundColor, panelColor, buttonColor, buttonTextColor } =
      banner;
    if (
      headline === null ||
      buttonLabel === null ||
      backgroundColor === null ||
      panelColor === null ||
      buttonColor === null ||
      buttonTextColor === null
    ) {
      return null;
    }
    return {
      id: banner.id,
      kind: 'hero',
      href: banner.href,
      headline,
      line: banner.line,
      eyebrow: banner.eyebrow,
      buttonLabel,
      desktopImage: this.image(banner.desktopImage, 'wide'),
      phoneImage: this.image(banner.phoneImage, 'large'),
      colors: {
        background: backgroundColor,
        panel: panelColor,
        button: buttonColor,
        buttonText: buttonTextColor,
      },
    };
  }

  // A listing's photos come checked from listing-sql.ts. A banner's pictures are jsonb objects
  // that the database checks only to be objects (storefront_banners_images_check), so their
  // shape is checked here
  private image(value: StorefrontImage, size: StorefrontImageSize) {
    return shopImage(this.mediaUrl, storefrontImageSchema.parse(value), size);
  }
}

// Every category of the shop, in the tenant's order: siblings by position, then by name
async function categoriesOf(tx: Transaction, shop: ShopScope): Promise<ShopCategory[]> {
  return tx
    .select({
      id: storefrontCategories.id,
      slug: storefrontCategories.slug,
      name: storefrontCategories.name,
      parentId: storefrontCategories.parentId,
    })
    .from(storefrontCategories)
    .where(eq(storefrontCategories.tenantId, shop.tenantId))
    .orderBy(
      asc(storefrontCategories.position),
      asc(sql`lower(${storefrontCategories.name})`),
      asc(storefrontCategories.id),
    );
}

// The cart's listings as the quote needs them, by id. Step 27a: shared with placing an order
// (orders/shop-orders.service.ts), so the order is priced from exactly the rows a quote reads.
// The cart's ids are checked first: anything that is not a uuid is a listing that cannot exist
export async function quotedListings(
  tx: Transaction,
  shop: ShopScope,
  lines: readonly { listingId: string }[],
  mediaUrl: string,
): Promise<Map<string, QuotedListing & { row: ListingRow }>> {
  const ids = lines.map((line) => line.listingId).filter((id) => uuidSchema.safeParse(id).success);
  const rows = await selectListings(tx, shop, sql`WHERE ${idIn(sql`shown.id`, ids)}`);
  const listings = new Map<string, QuotedListing & { row: ListingRow }>();
  for (const row of rows) {
    const listing = listingOf(row, shop, mediaUrl);
    // The card's photo (the first, small) is the cart line's photo too. It is always there
    // (listingRowSchema: at least one); TypeScript only cannot know it
    const [image] = listing.images;
    if (image !== undefined) listings.set(row.id, { listing, image, free: row.free, row });
  }
  return listings;
}

// The checkout's settings, also what the quote applies. Step 27a: exported for placing an order
export async function checkoutSettingsOf(
  tx: Transaction,
  shop: ShopScope,
): Promise<ShopCheckoutSettings> {
  const [settings] = await tx
    .select({
      zones: storefrontSettings.deliveryZones,
      paymentMethods: storefrontSettings.paymentMethods,
      freeDeliveryFrom: storefrontSettings.freeDeliveryFrom,
      minimumOrder: storefrontSettings.minimumOrder,
    })
    .from(storefrontSettings)
    .where(eq(storefrontSettings.tenantId, shop.tenantId));
  if (settings === undefined) throw storefrontNotFound();
  return {
    // A launched shop has one to six (storefront_settings_launch_check and zones_check); each
    // zone's shape is checked here, because jsonb holds whatever was written
    zones: z.array(shopDeliveryZoneSchema).parse(settings.zones),
    paymentMethods: offeredMethods(settings.paymentMethods),
    freeDeliveryFrom: settings.freeDeliveryFrom,
    minimumOrder: settings.minimumOrder,
  };
}

// Step 27a: the payment methods the checkout offers. Mobile Banking needs the shop's own gateway,
// which step 27c connects; until then an online order would only fail, so the checkout does not
// show it. A shop that ticked Mobile Banking alone keeps it (the contract needs at least one
// method), and placing such an order is refused as shop_payment_unavailable, which is true
export function offeredMethods(methods: readonly ShopPaymentMethod[]): ShopPaymentMethod[] {
  const working = methods.filter((method) => method !== 'online');
  return working.length > 0 ? working : [...methods];
}
