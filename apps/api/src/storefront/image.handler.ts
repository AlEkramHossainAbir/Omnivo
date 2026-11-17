import { Inject, Injectable, Logger } from '@nestjs/common';
import { attachments, storefrontImages } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { StorageService } from '../storage/storage.service.js';
import { makeShopImages, type StorefrontImageFailure } from './image-files.js';
import { shopImageKey } from './media.js';

// A new photo gets a new id, so the file under an address never changes (26f, decision 5)
const IMMUTABLE = 'public, max-age=31536000, immutable';

type Finish =
  | { status: 'ready'; width: number; height: number }
  | { status: 'failed'; failureCode: StorefrontImageFailure };

// Step 26g: an uploaded shop photo becomes the shop's three WebP files (decision 2). The original
// stays in the workspace's private folder; the files go to the public storefront/<id>/ folder.
//
// Idempotent like every handler: it works only on a row that is still processing, and it writes
// the files before it marks the row ready. A run that dies halfway leaves the row processing, so
// the retry makes the same files again (the same keys, so they are replaced, not doubled).
@Injectable()
export class StorefrontImageHandler implements EventHandler<'storefront.image_uploaded'> {
  private readonly logger = new Logger(StorefrontImageHandler.name);

  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
  ) {}

  async handle(event: OutboxEvent<'storefront.image_uploaded'>): Promise<void> {
    const { imageId } = event.payload;
    // A short read, then the slow work with no transaction open: decoding a 12 MP photo takes a
    // second or two, and a transaction held that long would hold a pooled connection with it
    const [job] = await this.withTenant((tx) =>
      tx
        .select({ status: storefrontImages.status, storageKey: attachments.storageKey })
        .from(storefrontImages)
        .innerJoin(
          attachments,
          and(
            eq(attachments.tenantId, storefrontImages.tenantId),
            eq(attachments.id, storefrontImages.id),
          ),
        )
        .where(and(eq(storefrontImages.tenantId, getTenantId()), eq(storefrontImages.id, imageId))),
    );
    // Done by an earlier run, or the attachment was deleted (the row went with it): nothing to do
    if (job?.status !== 'processing') return;

    const original = await this.storage.get(job.storageKey);
    // complete() saw the file before it queued this job, so a missing one was deleted since.
    // Trying again cannot bring it back: onGiveUp marks the photo failed
    if (!original) throw new PermanentJobError(`Photo ${imageId} has no original file`);

    const made = await makeShopImages(original);
    if (!made.ok) {
      await this.finish(imageId, { status: 'failed', failureCode: made.code });
      return;
    }
    // The files first: a row marked ready before its files exist would let a listing be
    // published with a photo that is not there yet
    for (const file of made.files) {
      await this.storage.put(shopImageKey(imageId, file.size), file.body, 'image/webp', IMMUTABLE);
    }
    await this.finish(imageId, { status: 'ready', width: made.width, height: made.height });
  }

  // The storage was down for every try, or the original is gone. The screen asks until the photo
  // is ready or failed; without this it would show "Preparing the photo…" for good
  async onGiveUp(event: OutboxEvent<'storefront.image_uploaded'>): Promise<void> {
    this.logger.warn(`Photo ${event.payload.imageId} given up after the last try`);
    await this.finish(event.payload.imageId, {
      status: 'failed',
      failureCode: 'storefront_image_unreadable',
    });
  }

  // Only a row still processing: a second run (or onGiveUp after a run that did finish) never
  // turns a ready photo into a failed one
  private async finish(imageId: string, result: Finish): Promise<void> {
    await this.withTenant((tx) =>
      tx
        .update(storefrontImages)
        .set({ ...result, processedAt: new Date() })
        .where(
          and(
            eq(storefrontImages.tenantId, getTenantId()),
            eq(storefrontImages.id, imageId),
            eq(storefrontImages.status, 'processing'),
          ),
        ),
    );
  }
}
