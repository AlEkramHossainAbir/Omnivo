import { Inject, Injectable } from '@nestjs/common';
import {
  type SaveStorefrontPageInput,
  SHOP_TEXT_PAGES,
  type ShopTextPageSlug,
  type StorefrontPage,
  type StorefrontPageSummary,
  type StorefrontSection,
} from '@omnivo/contracts';
import { storefrontPages } from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';

import { audit } from '../../common/audit/audit.js';
import { notFound, versionConflict } from '../../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import type { Config } from '../../config.js';
import { CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { shopUrl } from '../shop-url.js';
import { notSetUp, StorefrontSettingsService } from './settings.service.js';

type PageRow = typeof storefrontPages.$inferSelect;

// A page in the audit log: its headings, "Delivery, Returns, Payment". The sections' text can be
// long, so the log names what the page holds, not every word of it
function headings(sections: readonly StorefrontSection[] | undefined): string | null {
  return sections === undefined ? null : sections.map((section) => section.heading).join(', ');
}

// Step 26h: the footer's four text pages (decision 5). A page is a row from its first save until
// Delete; without a row the shop answers "page not found" for it and the footer leaves its link
// out (publicShopSchema.pages). A page has no id: its slug, one of the four, is its key.
@Injectable()
export class StorefrontPagesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: Config,
    private readonly settings: StorefrontSettingsService,
  ) {}

  // Always the four, in the footer's order, written or not
  list(): Promise<{ items: StorefrontPageSummary[] }> {
    return this.withTenant(async (tx) => {
      const subdomain = await this.subdomain(tx);
      const rows = await tx
        .select()
        .from(storefrontPages)
        .where(eq(storefrontPages.tenantId, getTenantId()));
      const bySlug = new Map(rows.map((row) => [row.slug, row]));
      return {
        items: SHOP_TEXT_PAGES.map((slug) => {
          const { sections, ...page } = this.toPage(subdomain, slug, bySlug.get(slug));
          return { ...page, sectionCount: sections.length };
        }),
      };
    });
  }

  get(slug: ShopTextPageSlug): Promise<StorefrontPage> {
    return this.withTenant(async (tx) => {
      const subdomain = await this.subdomain(tx);
      return this.toPage(subdomain, slug, await this.find(tx, slug));
    });
  }

  save(slug: ShopTextPageSlug, input: SaveStorefrontPageInput): Promise<StorefrontPage> {
    return this.withTenant(async (tx) => {
      const subdomain = await this.subdomain(tx);
      const before = await this.find(tx, slug);
      // As the hero (decision 13): version null is "not written yet". A row and no version, or a
      // version and no row: another tab wrote or deleted the page since this form opened
      if ((before === undefined) !== (input.version === null)) throw versionConflict();
      if (before !== undefined && before.version !== input.version) throw versionConflict();
      const [after] =
        before === undefined
          ? await tx
              .insert(storefrontPages)
              .values({
                tenantId: getTenantId(),
                slug,
                sections: input.sections,
                updatedBy: currentPrincipal().userId,
              })
              // Two first saves at once: the second finds the first's row. Not an upsert, for the
              // settings' reason: it would overwrite the other tab's page without its version
              .onConflictDoNothing({ target: [storefrontPages.tenantId, storefrontPages.slug] })
              .returning()
          : await tx
              .update(storefrontPages)
              .set({
                sections: input.sections,
                version: sql`${storefrontPages.version} + 1`,
                updatedBy: currentPrincipal().userId,
              })
              .where(
                and(eq(storefrontPages.tenantId, getTenantId()), eq(storefrontPages.slug, slug)),
              )
              .returning();
      if (!after) throw versionConflict();
      await audit(tx, {
        action: 'storefront.page_saved',
        entityType: 'storefront',
        entityId: getTenantId(),
        // Keyed by the slug, so the log says which page: "terms: Delivery → Delivery, Returns".
        // Built by hand, not with diff(): a save that changed only the text keeps the same
        // headings, and diff() would leave the page out of its own entry
        changes: { [slug]: { from: headings(before?.sections), to: headings(after.sections) } },
      });
      return this.toPage(subdomain, slug, after);
    });
  }

  remove(slug: ShopTextPageSlug, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.find(tx, slug);
      if (before === undefined) throw notFound('Page');
      if (before.version !== version) throw versionConflict();
      await tx
        .delete(storefrontPages)
        .where(and(eq(storefrontPages.tenantId, getTenantId()), eq(storefrontPages.slug, slug)));
      await audit(tx, {
        action: 'storefront.page_deleted',
        entityType: 'storefront',
        entityId: getTenantId(),
        changes: { [slug]: { from: headings(before.sections), to: null } },
      });
    });
  }

  // The shop's subdomain, for the pages' addresses. A shop not set up has no address yet, and its
  // screens show "Set up the shop first" (the catalog's rule)
  private async subdomain(tx: Transaction): Promise<string> {
    const shop = await this.settings.find(tx, false);
    if (shop === null) throw notSetUp();
    return shop.subdomain;
  }

  private async find(tx: Transaction, slug: ShopTextPageSlug): Promise<PageRow | undefined> {
    const [row] = await tx
      .select()
      .from(storefrontPages)
      .where(and(eq(storefrontPages.tenantId, getTenantId()), eq(storefrontPages.slug, slug)))
      .for('update');
    return row;
  }

  private toPage(
    subdomain: string,
    slug: ShopTextPageSlug,
    row: PageRow | undefined,
  ): StorefrontPage {
    return {
      slug,
      sections: row?.sections ?? [],
      shopUrl: shopUrl(this.config.storefront, subdomain, `/pages/${slug}`),
      version: row?.version ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }
}
