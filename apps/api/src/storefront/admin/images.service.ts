import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateStorefrontUploadInput,
  StorefrontImage,
  StorefrontImageView,
  StorefrontUpload,
  StorefrontUploadTicket,
} from '@omnivo/contracts';
import { attachments, storefrontImages } from '@omnivo/db';
import { and, eq, inArray } from 'drizzle-orm';

import { AttachmentsService } from '../../attachments/attachments.service.js';
import { emit } from '../../common/outbox/outbox.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import type { Config } from '../../config.js';
import { CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { shopImage } from '../media.js';

const PHOTO = ['storefront_image'] as const;

type ImageRow = typeof storefrontImages.$inferSelect;

// Step 26g: the shop's photos (decisions 2 and 8). The file goes up like any attachment, with a
// presigned PUT to the workspace's private folder; confirming it starts the image job. A photo's
// id is its attachment's id from then on: the job's row, the WebP files and the listings all use it.
@Injectable()
export class StorefrontImagesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: Config,
    private readonly attachments: AttachmentsService,
  ) {}

  createUpload(input: CreateStorefrontUploadInput): Promise<StorefrontUploadTicket> {
    return this.withTenant(async (tx) => {
      const { row, upload } = await this.attachments.startUpload(tx, 'storefront_image', input);
      return { image: { id: row.id, status: 'uploading' }, upload };
    });
  }

  // The attachment's check (the file is there, its size and type are what was said), then, in
  // the same transaction, the job's row and its outbox event: all three commit or none do. A
  // second confirm (a retry after a lost answer) finds the row and starts nothing
  complete(id: string): Promise<StorefrontUpload> {
    return this.withTenant(async (tx) => {
      await this.attachments.confirm(tx, id, PHOTO);
      const [row] = await tx
        .insert(storefrontImages)
        .values({ id, tenantId: getTenantId() })
        .onConflictDoNothing({ target: storefrontImages.id })
        .returning();
      if (row) await emit(tx, 'storefront.image_uploaded', { imageId: id });
      return this.statusOf(id, row ?? (await this.jobRow(tx, id)));
    });
  }

  get(id: string): Promise<StorefrontUpload> {
    return this.withTenant(async (tx) => {
      // 404 for anything that is not this workspace's shop photo (another purpose included)
      await this.attachments.find(tx, id, PHOTO, false);
      return this.statusOf(id, await this.jobRow(tx, id));
    });
  }

  // The ids among these that a listing may save: this workspace's shop photos whose files are
  // made. Everything else (another workspace's id, a logo, a photo still processing or failed) is
  // missing from the answer, and the save says storefront_image_not_ready on that photo
  async readyIds(tx: Transaction, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await tx
      .select({ id: storefrontImages.id })
      .from(storefrontImages)
      .innerJoin(
        attachments,
        and(
          eq(attachments.tenantId, storefrontImages.tenantId),
          eq(attachments.id, storefrontImages.id),
        ),
      )
      .where(
        and(
          eq(storefrontImages.tenantId, getTenantId()),
          inArray(storefrontImages.id, [...ids]),
          eq(storefrontImages.status, 'ready'),
          eq(attachments.purpose, 'storefront_image'),
        ),
      );
    return new Set(rows.map((row) => row.id));
  }

  // A saved photo as the editor shows it: the small file, for the thumbnail
  view(image: StorefrontImage): StorefrontImageView {
    return { ...image, url: shopImage(this.config.storefront.mediaUrl, image, 'small').url };
  }

  private async jobRow(tx: Transaction, id: string): Promise<ImageRow | undefined> {
    const [row] = await tx
      .select()
      .from(storefrontImages)
      .where(and(eq(storefrontImages.tenantId, getTenantId()), eq(storefrontImages.id, id)));
    return row;
  }

  // The table's states into the screen's union (26g.2's table). The table's check makes each
  // state carry its own fields; the guards below are for the type checker, and a row that broke
  // them would be a bug worth an error, not a photo shown half
  private statusOf(id: string, row: ImageRow | undefined): StorefrontUpload {
    if (row === undefined) return { id, status: 'uploading' };
    switch (row.status) {
      case 'processing':
        return { id, status: 'processing' };
      case 'ready':
        if (row.width === null || row.height === null) {
          throw new Error(`Photo ${id} is ready without a size`);
        }
        return {
          id,
          status: 'ready',
          url: shopImage(this.config.storefront.mediaUrl, { id, alt: '' }, 'small').url,
          width: row.width,
          height: row.height,
        };
      case 'failed':
        if (row.failureCode === null) throw new Error(`Photo ${id} failed without a code`);
        return { id, status: 'failed', code: row.failureCode };
    }
  }
}
