import { Inject, Injectable } from '@nestjs/common';
import { documentFiles } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { DocumentFileMaker } from './file-maker.js';

type Event = OutboxEvent<'document.file_requested'>;

// Draws a document's PDF (step 16). Nobody is told when it is done: the page that asked polls the
// file (decision 5), and a link's page asks again on its own.
@Injectable()
export class DocumentFileHandler implements EventHandler<'document.file_requested'> {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly maker: DocumentFileMaker,
  ) {}

  async handle(event: Event): Promise<void> {
    const row = await this.maker.load(event.payload.fileId);
    // Done already: a second run of this job, or the email job drew it first
    if (row.status === 'ready') return;
    await this.maker.make(row);
  }

  // After the last attempt the row says "failed", so the waiting page stops and offers Retry,
  // which asks again (decision 19). No bell: the person is looking at the page.
  async onGiveUp(event: Event): Promise<void> {
    await this.withTenant((tx) =>
      tx
        .update(documentFiles)
        .set({ status: 'failed', finishedAt: new Date() })
        .where(
          and(
            eq(documentFiles.tenantId, getTenantId()),
            eq(documentFiles.id, event.payload.fileId),
            eq(documentFiles.status, 'pending'),
          ),
        ),
    );
  }
}
