import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateStorefrontBannerInput,
  type ErrorCode,
  type MoveStorefrontHomeBlockInput,
  type SaveStorefrontHeroInput,
  STOREFRONT_BANNERS_MAX,
  type StorefrontAppearance,
  type StorefrontBanner,
  type StorefrontHero,
  type StorefrontHomeBlock,
  type StorefrontImage,
  storefrontImageSchema,
  type StorefrontTheme,
  type UpdateStorefrontBannerInput,
  type UpdateStorefrontThemeInput,
} from '@omnivo/contracts';
import { storefrontBanners, storefrontSettings } from '@omnivo/db';
import { and, count, eq, sql } from 'drizzle-orm';

import { audit, created, diff } from '../../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import type { Config } from '../../config.js';
import { CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { shopImage } from '../media.js';
import { shopUrl } from '../shop-url.js';
import { StorefrontCollectionsService } from './collections.service.js';
import {
  appendHomeBlock,
  checkHomeRoom,
  full,
  homeBlockRefs,
  homeBlocksOf,
  lockHome,
  writeHomeBlocks,
} from './home-blocks.js';
import { StorefrontImagesService } from './images.service.js';
import { notSetUp, StorefrontSettingsService } from './settings.service.js';

type BannerRow = typeof storefrontBanners.$inferSelect;
type SettingsRow = typeof storefrontSettings.$inferSelect;

// A picture that is not ready (or not this workspace's), on its own box. One error per picture
function imagesNotReady(fields: readonly string[]): AppError {
  const fieldErrors: Record<string, ErrorCode[]> = {};
  for (const field of fields) fieldErrors[field] = ['storefront_image_not_ready'];
  return new AppError(409, 'storefront_image_not_ready', 'A picture is not ready yet.', {
    fieldErrors,
  });
}

// The audit's view of a banner: its link and its pictures (the id and the alt text, so a new
// picture and a corrected alt both show). The hero adds its words and colors
function bannerSnapshot(row: BannerRow) {
  return {
    kind: row.kind,
    href: row.href,
    desktopImage: row.desktopImage.id,
    desktopAlt: row.desktopImage.alt,
    phoneImage: row.phoneImage.id,
    phoneAlt: row.phoneImage.alt,
    headline: row.headline,
    line: row.line,
    eyebrow: row.eyebrow,
    buttonLabel: row.buttonLabel,
    backgroundColor: row.backgroundColor,
    panelColor: row.panelColor,
    buttonColor: row.buttonColor,
    buttonTextColor: row.buttonTextColor,
  };
}

// Step 26h: the Appearance page (decision 2). The logo and the two colors live on the settings
// row; the hero and the picture banners are rows of storefront_banners (kind hero / image); the
// collections have their own service. The home page's order is shared (home-blocks.ts).
@Injectable()
export class StorefrontAppearanceService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: Config,
    private readonly settings: StorefrontSettingsService,
    private readonly images: StorefrontImagesService,
    private readonly collections: StorefrontCollectionsService,
  ) {}

  get(): Promise<StorefrontAppearance> {
    return this.withTenant(async (tx) => {
      const shop = await this.requireShop(tx);
      const [hero] = await tx
        .select()
        .from(storefrontBanners)
        .where(
          and(eq(storefrontBanners.tenantId, getTenantId()), eq(storefrontBanners.kind, 'hero')),
        );
      return {
        shopUrl: shopUrl(this.config.storefront, shop.subdomain),
        theme: this.toTheme(shop),
        hero: hero === undefined ? null : this.toHero(hero),
        blocks: await this.blocks(tx),
      };
    });
  }

  async updateTheme(input: UpdateStorefrontThemeInput): Promise<StorefrontTheme> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.settings.find(tx, true);
        if (before === null) throw notSetUp();
        if (before.version !== input.version) throw versionConflict();
        // Only a new logo is asked: the saved one was ready when it was saved, and its files never
        // change
        if (input.logoImageId !== null && input.logoImageId !== before.logoImageId) {
          const ready = await this.images.readyIds(tx, [input.logoImageId]);
          if (!ready.has(input.logoImageId)) throw imagesNotReady(['logoImageId']);
        }
        const [after] = await tx
          .update(storefrontSettings)
          .set({
            logoImageId: input.logoImageId,
            brandColor: input.brandColor,
            accentColor: input.accentColor,
            // The settings row's one version (decision 12): Shop settings and this card cannot
            // overwrite each other unseen
            version: sql`${storefrontSettings.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(eq(storefrontSettings.tenantId, getTenantId()))
          .returning();
        if (!after) throw notSetUp();
        const view = (row: SettingsRow) => ({
          logoImageId: row.logoImageId,
          brandColor: row.brandColor,
          accentColor: row.accentColor,
        });
        await audit(tx, {
          action: 'storefront.theme_updated',
          entityType: 'storefront',
          entityId: after.tenantId,
          changes: diff(view(before), view(after)),
        });
        return this.toTheme(after);
      });
    } catch (error) {
      // The FK (26h.2) behind the check above: a photo of another workspace never gets this far,
      // so this is a race with nothing today (photos are never deleted yet). Said on the box anyway
      if (isForeignKeyViolation(error, 'storefront_settings_logo_fk')) {
        throw imagesNotReady(['logoImageId']);
      }
      throw error;
    }
  }

  // version null makes the hero, a number changes it (decision 13)
  async saveHero(input: SaveStorefrontHeroInput): Promise<StorefrontHero> {
    try {
      return await this.withTenant(async (tx) => {
        await this.requireShop(tx);
        const before = await this.findHero(tx);
        // No hero and a version: another tab deleted it. A hero and no version: another tab made
        // one. Either way this form shows something that is not there any more
        if ((before === null) !== (input.version === null)) throw versionConflict();
        if (before !== null && before.version !== input.version) throw versionConflict();
        await this.checkImages(tx, input, before);
        const columns = {
          href: input.href,
          headline: input.headline,
          line: input.line,
          eyebrow: input.eyebrow,
          buttonLabel: input.buttonLabel,
          desktopImage: input.desktopImage,
          phoneImage: input.phoneImage,
          backgroundColor: input.backgroundColor,
          panelColor: input.panelColor,
          buttonColor: input.buttonColor,
          buttonTextColor: input.buttonTextColor,
          updatedBy: currentPrincipal().userId,
        };
        const [after] =
          before === null
            ? await tx
                .insert(storefrontBanners)
                .values({ tenantId: getTenantId(), kind: 'hero', ...columns })
                .returning()
            : await tx
                .update(storefrontBanners)
                .set({ ...columns, version: sql`${storefrontBanners.version} + 1` })
                .where(
                  and(
                    eq(storefrontBanners.tenantId, getTenantId()),
                    eq(storefrontBanners.id, before.id),
                  ),
                )
                .returning();
        if (!after) throw new Error('Hero save returned no row');
        await audit(tx, {
          action: before === null ? 'storefront_banner.created' : 'storefront_banner.updated',
          entityType: 'storefront_banner',
          entityId: after.id,
          changes:
            before === null
              ? created(bannerSnapshot(after))
              : diff(bannerSnapshot(before), bannerSnapshot(after)),
        });
        return this.toHero(after);
      });
    } catch (error) {
      // Two first saves at once: both saw no hero, and the one-hero index stopped the second
      if (isUniqueViolation(error, 'storefront_banners_hero_idx')) throw versionConflict();
      throw error;
    }
  }

  deleteHero(version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.findHero(tx);
      if (before === null) throw notFound('Hero');
      if (before.version !== version) throw versionConflict();
      await this.deleteBannerRow(tx, before);
    });
  }

  createBanner(input: CreateStorefrontBannerInput): Promise<StorefrontBanner> {
    return this.withTenant(async (tx) => {
      await lockHome(tx);
      await this.requireShop(tx);
      const [counted] = await tx
        .select({ total: count() })
        .from(storefrontBanners)
        .where(
          and(eq(storefrontBanners.tenantId, getTenantId()), eq(storefrontBanners.kind, 'image')),
        );
      if ((counted?.total ?? 0) >= STOREFRONT_BANNERS_MAX) {
        throw full('storefront_banners_full', 'The shop has 6 picture banners. Remove one first.');
      }
      await checkHomeRoom(tx);
      await this.checkImages(tx, input, null);
      const [row] = await tx
        .insert(storefrontBanners)
        .values({
          tenantId: getTenantId(),
          kind: 'image',
          href: input.href,
          desktopImage: input.desktopImage,
          phoneImage: input.phoneImage,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Banner insert returned no row');
      await appendHomeBlock(tx, { bannerId: row.id, collectionId: null });
      await audit(tx, {
        action: 'storefront_banner.created',
        entityType: 'storefront_banner',
        entityId: row.id,
        changes: created(bannerSnapshot(row)),
      });
      return this.toBanner(row);
    });
  }

  updateBanner(id: string, input: UpdateStorefrontBannerInput): Promise<StorefrontBanner> {
    return this.withTenant(async (tx) => {
      const before = await this.findBanner(tx, id);
      if (before.version !== input.version) throw versionConflict();
      await this.checkImages(tx, input, before);
      const [after] = await tx
        .update(storefrontBanners)
        .set({
          href: input.href,
          desktopImage: input.desktopImage,
          phoneImage: input.phoneImage,
          version: sql`${storefrontBanners.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(storefrontBanners.tenantId, getTenantId()), eq(storefrontBanners.id, id)))
        .returning();
      if (!after) throw notFound('Banner');
      await audit(tx, {
        action: 'storefront_banner.updated',
        entityType: 'storefront_banner',
        entityId: id,
        changes: diff(bannerSnapshot(before), bannerSnapshot(after)),
      });
      return this.toBanner(after);
    });
  }

  deleteBanner(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      await lockHome(tx);
      const before = await this.findBanner(tx, id);
      if (before.version !== version) throw versionConflict();
      await this.deleteBannerRow(tx, before);
      // Its block went with it (the FK cascades); the gap closes, as after a collection's delete
      await writeHomeBlocks(tx, await homeBlockRefs(tx));
    });
  }

  // Decision 14: a swap with the block above or below, answered with the whole page
  moveBlock(input: MoveStorefrontHomeBlockInput): Promise<{ blocks: StorefrontHomeBlock[] }> {
    return this.withTenant(async (tx) => {
      await lockHome(tx);
      const refs = await homeBlockRefs(tx);
      const from = refs.findIndex((ref) =>
        input.kind === 'banner' ? ref.bannerId === input.id : ref.collectionId === input.id,
      );
      const block = refs[from];
      if (block === undefined) throw notFound(input.kind === 'banner' ? 'Banner' : 'Collection');
      const to = input.direction === 'up' ? from - 1 : from + 1;
      const neighbour = refs[to];
      // Already first or last: the button is disabled there, and a second click is a no-op
      if (neighbour === undefined) return { blocks: await this.blocks(tx) };
      const order = [...refs];
      order[from] = neighbour;
      order[to] = block;
      await writeHomeBlocks(tx, order);
      // The block's own entity, so the log's link opens what moved; the page's order is the shop's
      await audit(tx, {
        action: 'storefront.home_moved',
        entityType: input.kind === 'banner' ? 'storefront_banner' : 'storefront_collection',
        entityId: input.id,
        changes: diff({ position: from + 1 }, { position: to + 1 }),
      });
      return { blocks: await this.blocks(tx) };
    });
  }

  private async requireShop(tx: Transaction): Promise<SettingsRow> {
    const shop = await this.settings.find(tx, false);
    if (shop === null) throw notSetUp();
    return shop;
  }

  private async findHero(tx: Transaction): Promise<BannerRow | null> {
    const [row] = await tx
      .select()
      .from(storefrontBanners)
      .where(and(eq(storefrontBanners.tenantId, getTenantId()), eq(storefrontBanners.kind, 'hero')))
      .for('update');
    return row ?? null;
  }

  // A picture banner. The hero has its own routes: through these it is "not found"
  private async findBanner(tx: Transaction, id: string): Promise<BannerRow> {
    const [row] = await tx
      .select()
      .from(storefrontBanners)
      .where(
        and(
          eq(storefrontBanners.tenantId, getTenantId()),
          eq(storefrontBanners.id, id),
          eq(storefrontBanners.kind, 'image'),
        ),
      )
      .for('update');
    if (!row) throw notFound('Banner');
    return row;
  }

  private async deleteBannerRow(tx: Transaction, before: BannerRow): Promise<void> {
    await tx
      .delete(storefrontBanners)
      .where(
        and(eq(storefrontBanners.tenantId, getTenantId()), eq(storefrontBanners.id, before.id)),
      );
    const snapshot = bannerSnapshot(before);
    await audit(tx, {
      action: 'storefront_banner.deleted',
      entityType: 'storefront_banner',
      entityId: before.id,
      // Every field to null, the kind too ("kind: hero → none"), so a deleted hero reads as the hero
      changes: diff(snapshot, Object.fromEntries(Object.keys(snapshot).map((key) => [key, null]))),
    });
  }

  // Both pictures are this workspace's and ready. A picture the banner has already is not asked
  // again (the listings' rule, listings.service.ts checkImages)
  private async checkImages(
    tx: Transaction,
    input: { desktopImage: StorefrontImage; phoneImage: StorefrontImage },
    before: BannerRow | null,
  ): Promise<void> {
    const saved = new Set(before === null ? [] : [before.desktopImage.id, before.phoneImage.id]);
    const fields = [
      ['desktopImage', input.desktopImage.id],
      ['phoneImage', input.phoneImage.id],
    ] as const;
    const asked = fields.filter(([, id]) => !saved.has(id)).map(([, id]) => id);
    const ready = await this.images.readyIds(tx, asked);
    const missing = fields
      .filter(([, id]) => !saved.has(id) && !ready.has(id))
      .map(([field]) => field);
    if (missing.length > 0) throw imagesNotReady(missing);
  }

  // The page's blocks: the picture banners and the collections, in the page's order
  private async blocks(tx: Transaction): Promise<StorefrontHomeBlock[]> {
    const rows = await tx
      .select()
      .from(storefrontBanners)
      .where(
        and(eq(storefrontBanners.tenantId, getTenantId()), eq(storefrontBanners.kind, 'image')),
      );
    const banners = new Map(rows.map((row) => [row.id, this.toBanner(row)]));
    return homeBlocksOf(await homeBlockRefs(tx), banners, await this.collections.summaries(tx));
  }

  private toTheme(row: SettingsRow): StorefrontTheme {
    return {
      logo:
        row.logoImageId === null
          ? null
          : {
              id: row.logoImageId,
              url: shopImage(
                this.config.storefront.mediaUrl,
                { id: row.logoImageId, alt: row.name },
                'small',
              ).url,
            },
      brandColor: row.brandColor,
      accentColor: row.accentColor,
      name: row.name,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // The pictures are jsonb that the database checks only to be objects; their shape is checked
  // here, as the shop's side does (public-storefront.service.ts image())
  private picture(value: StorefrontImage) {
    return this.images.view(storefrontImageSchema.parse(value));
  }

  private toBanner(row: BannerRow): StorefrontBanner {
    return {
      id: row.id,
      href: row.href,
      desktopImage: this.picture(row.desktopImage),
      phoneImage: this.picture(row.phoneImage),
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // A hero row has its words and colors (storefront_banners_hero_check); the guard tells
  // TypeScript, and a row that broke it would be a bug worth an error, not a hero shown half
  private toHero(row: BannerRow): StorefrontHero {
    const { headline, buttonLabel, backgroundColor, panelColor, buttonColor, buttonTextColor } =
      row;
    if (
      headline === null ||
      buttonLabel === null ||
      backgroundColor === null ||
      panelColor === null ||
      buttonColor === null ||
      buttonTextColor === null
    ) {
      throw new Error(`Hero ${row.id} is missing its words or colors`);
    }
    return {
      ...this.toBanner(row),
      headline,
      line: row.line,
      eyebrow: row.eyebrow,
      buttonLabel,
      backgroundColor,
      panelColor,
      buttonColor,
      buttonTextColor,
    };
  }
}
