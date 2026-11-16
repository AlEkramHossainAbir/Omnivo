import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type Attachment,
  type AttachmentPurpose,
  type CreateUploadInput,
  GENERAL_UPLOAD_PURPOSES,
  type UploadTicket,
} from '@omnivo/contracts';
import { attachments } from '@omnivo/db';
import { and, eq, inArray } from 'drizzle-orm';

import { AppError, notFound } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { StorageService, type SignedUrl } from '../storage/storage.service.js';

// আপলোডের ঠিকানা ১০ মিনিট চলে — ধীর নেটওয়ার্কে ২ MB-র জন্য যথেষ্ট, আর ফাঁস হলেও বেশিক্ষণ কাজে লাগে না
const UPLOAD_TTL_SECONDS = 10 * 60;

export type AttachmentRow = typeof attachments.$inferSelect;

// Step 26g: what a file is, before its upload. The route's own schema has checked it against its
// purpose's rule (size and type)
export interface UploadFile {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    purpose: row.purpose,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

function uploadIncomplete(): AppError {
  return new AppError(409, 'upload_incomplete', "The file wasn't uploaded, or it doesn't match.");
}

@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
  ) {}

  // ধাপ ১: রো (pending) + সই করা PUT ঠিকানা। ফাইল নিজে কখনো API-তে আসে না
  createUpload(input: CreateUploadInput): Promise<UploadTicket> {
    const { purpose, ...file } = input;
    return this.withTenant(async (tx) => {
      const { row, upload } = await this.startUpload(tx, purpose, file);
      return { attachment: toAttachment(row), upload };
    });
  }

  // Step 26g: the same first step for a purpose with its own routes (a shop photo, with
  // storefront.manage), inside the caller's transaction
  async startUpload(
    tx: Transaction,
    purpose: AttachmentPurpose,
    file: UploadFile,
  ): Promise<{ row: AttachmentRow; upload: UploadTicket['upload'] }> {
    const tenantId = getTenantId();
    const now = new Date();
    // system-design §৩.৭-এর পাথ। টেন্যান্ট দিয়ে শুরু: একটা টেন্যান্টের সব ফাইল এক prefix-এ — export,
    // মুছে ফেলা বা অন্য region-এ সরানো এক কমান্ডে। UTC মাস: পাথ শুধু সাজানোর জন্য, কারো চোখে পড়ে না
    const key = [
      'tenants',
      tenantId,
      purpose,
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      randomUUID(),
    ].join('/');

    const [row] = await tx
      .insert(attachments)
      .values({ tenantId, purpose, ...file, storageKey: key, createdBy: currentPrincipal().userId })
      .returning();
    if (!row) throw new Error('Attachment insert returned no row');
    const upload = await this.storage.uploadUrl(key, file.contentType, UPLOAD_TTL_SECONDS);
    return {
      row,
      upload: {
        method: 'PUT',
        url: upload.url,
        headers: { 'content-type': file.contentType },
        expiresAt: upload.expiresAt.toISOString(),
      },
    };
  }

  // ধাপ ২: ব্রাউজার বলে "পাঠিয়েছি" — কিন্তু বিশ্বাস না করে storage-কে জিজ্ঞেস করা হয়। presigned PUT
  // আকার বাঁধতে পারে না (S3-এর POST policy পারে, R2 সেটা সমর্থন করে না) — তাই ২ MB ঘোষণা করে ২০০ MB
  // পাঠানো ঠেকানোর জায়গা এটাই: না মিললে ফাইল মুছে 409
  complete(id: string): Promise<Attachment> {
    return this.withTenant(async (tx) =>
      toAttachment(await this.confirm(tx, id, GENERAL_UPLOAD_PURPOSES)),
    );
  }

  // Step 26g: the check itself, for any purpose, inside the caller's transaction. The row is
  // locked, so two confirms of one file wait for each other. Only the given purposes: a shop
  // photo is not confirmed through POST /attachments, and a logo not through the shop's route
  async confirm(
    tx: Transaction,
    id: string,
    purposes: readonly AttachmentPurpose[],
  ): Promise<AttachmentRow> {
    const row = await this.find(tx, id, purposes, true);
    if (row.status === 'ready') return row;

    const stored = await this.storage.head(row.storageKey);
    if (!stored) throw uploadIncomplete();
    if (stored.sizeBytes !== row.sizeBytes || stored.contentType !== row.contentType) {
      await this.storage.delete(row.storageKey);
      throw uploadIncomplete();
    }

    const [ready] = await tx
      .update(attachments)
      .set({ status: 'ready', updatedBy: currentPrincipal().userId })
      .where(eq(attachments.id, id))
      .returning();
    if (!ready) throw notFound('Attachment');
    return ready;
  }

  // The general route's files only. A shop photo's original keeps the phone's EXIF (its GPS
  // position too); only the image job reads it, and the shop gets the stripped WebP files
  download(id: string): Promise<SignedUrl> {
    return this.withTenant(async (tx) => {
      const row = await this.find(tx, id, GENERAL_UPLOAD_PURPOSES, false);
      if (row.status !== 'ready') {
        throw new AppError(409, 'attachment_not_ready', 'The file has not finished uploading.');
      }
      return this.storage.downloadUrl(row.storageKey, row.contentType);
    });
  }

  // Another purpose's file is "not found", like another workspace's: the route does not know it
  async find(
    tx: Transaction,
    id: string,
    purposes: readonly AttachmentPurpose[],
    forUpdate: boolean,
  ): Promise<AttachmentRow> {
    const query = tx
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.tenantId, getTenantId()),
          eq(attachments.id, id),
          inArray(attachments.purpose, [...purposes]),
        ),
      );
    const [row] = forUpdate ? await query.for('update') : await query;
    if (!row) throw notFound('Attachment');
    return row;
  }
}
