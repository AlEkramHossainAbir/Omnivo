import { Inject, Injectable } from '@nestjs/common';
import type { PublicDocument } from '@omnivo/contracts';
import { type Db, documentShares } from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId, runWithTenant } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { DB, WITH_TENANT } from '../infra/tokens.js';
import { StorageService } from '../storage/storage.service.js';
import { DocumentFiles } from './files.js';
import { type BuiltDocument, DocumentModels } from './models.service.js';
import { hashShareToken } from './share-token.js';

// Unknown, ended, turned off, or the document is gone or no longer issued (a voided receipt): one
// answer for all (decision 14). Telling them apart would tell a stranger which tokens were real.
function shareLinkNotFound(): AppError {
  return new AppError(404, 'share_link_not_found', 'This link does not work any more.');
}

// The page behind a share link (/d/:token in the app), opened by a customer without a login
@Injectable()
export class PublicDocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly models: DocumentModels,
    private readonly files: DocumentFiles,
    private readonly storage: StorageService,
  ) {}

  async get(token: string): Promise<PublicDocument> {
    const share = await this.findByToken(token);
    // From here on the link's own workspace, like a job in the worker: every read and write is
    // under tenant_isolation, and the token's policy is not needed again
    return runWithTenant(share.tenantId, async () => {
      const built = await this.build(share);
      const row = await this.withTenant(async (tx) => {
        // Stamped in the link's tenant (the token alone cannot write, 16.2). greatest(): two phones
        // opening it at once commit in any order, and the last opening never moves back.
        await tx
          .update(documentShares)
          .set({
            firstOpenedAt: sql`coalesce(${documentShares.firstOpenedAt}, now())`,
            lastOpenedAt: sql`greatest(${documentShares.lastOpenedAt}, now())`,
          })
          .where(and(eq(documentShares.tenantId, getTenantId()), eq(documentShares.id, share.id)));
        // The PDF in the link's language, drawn now if the document changed since the link was
        // made (an invoice that got paid). Nobody asked for it by name: requestedBy is null.
        return this.files.request(tx, built, null);
      });
      const logo = built.company.logo;
      return {
        company: built.company.name,
        logoUrl:
          logo === null ? null : (await this.storage.downloadUrl(logo.key, logo.contentType)).url,
        kind: share.kind,
        number: built.summary.number,
        date: built.summary.date,
        recipient: built.recipient.name,
        total: built.summary.total,
        currency: built.summary.currency,
        dueDate: built.summary.dueDate,
        amountDue: built.summary.amountDue,
        language: share.language,
        file: await this.files.toDocumentFile(row),
      };
    });
  }

  // Before the workspace is known. document_shares has FORCE RLS; migration 0034's share_by_token
  // policy shows only the row whose hash this transaction set, like an invitation (step 7).
  private async findByToken(token: string): Promise<typeof documentShares.$inferSelect> {
    const hash = hashShareToken(token);
    const [share] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.share_token_hash', ${hash}, true)`);
      return tx.select().from(documentShares).where(eq(documentShares.tokenHash, hash));
    });
    // No row at all also ends here: undefined !== null
    if (share?.revokedAt !== null || share.expiresAt <= new Date()) {
      throw shareLinkNotFound();
    }
    return share;
  }

  // A deleted quotation, or a receipt voided after the link was sent, ends the link too
  private async build(share: typeof documentShares.$inferSelect): Promise<BuiltDocument> {
    try {
      return await this.models.build(share.kind, share.documentId, share.language);
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === 'not_found' || error.code === 'document_not_issued')
      ) {
        throw shareLinkNotFound();
      }
      throw error;
    }
  }
}
