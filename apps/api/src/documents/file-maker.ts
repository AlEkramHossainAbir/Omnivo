import { Inject, Injectable } from '@nestjs/common';
import { documentFiles } from '@omnivo/db';
import { and, eq, ne } from 'drizzle-orm';

import { PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { StorageService } from '../storage/storage.service.js';
import { type FileRow, storageKeyOf } from './files.js';
import { type DocumentModel, documentModelSchema } from './model.js';
import { writeDocumentPdf } from './pdf.js';

const PDF = 'application/pdf';

// The model as stored. jsonb is data from outside this code (an older API wrote it), so it is
// parsed, not cast. One this worker cannot read will not read on a retry either: a permanent
// failure, and the next request writes a new row with a model of today's shape.
export function modelOf(row: FileRow): DocumentModel {
  const parsed = documentModelSchema.safeParse(row.model);
  if (!parsed.success) {
    throw new PermanentJobError(`Document file ${row.id} has a model this worker cannot read`);
  }
  return parsed.data;
}

// The worker's half of a PDF, shared by the file job and the email job: read a row, and draw,
// store and finish it. Runs inside the event's tenant context, like every handler.
@Injectable()
export class DocumentFileMaker {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
  ) {}

  async load(fileId: string): Promise<FileRow> {
    const [row] = await this.withTenant((tx) =>
      tx
        .select()
        .from(documentFiles)
        .where(and(eq(documentFiles.tenantId, getTenantId()), eq(documentFiles.id, fileId))),
    );
    // A file row is a cache and may have been cleaned away: nothing a retry could fix
    if (!row) throw new PermanentJobError('The document file no longer exists');
    return row;
  }

  // The PDF's bytes: the stored file when it is ready, else drawn now
  async bytes(row: FileRow): Promise<Uint8Array> {
    if (row.status === 'ready' && row.storageKey !== null) {
      const stored = await this.storage.get(row.storageKey);
      if (stored !== null) return stored;
      // The object is missing from storage although the row is ready (removed by hand). The row
      // cannot change, so the same file goes back under the same key.
      const bytes = await this.draw(row);
      await this.storage.put(row.storageKey, bytes, PDF);
      return bytes;
    }
    return this.make(row);
  }

  // Draws the row's model, stores it under the row's key and marks the row ready. A second run (a
  // retry, or the file job and the email job at the same moment) writes the same object again, and
  // `status <> 'ready'` lets only the first update through. A failed row is finished too: the
  // email job may draw a file whose own job gave up.
  async make(row: FileRow): Promise<Uint8Array> {
    const bytes = await this.draw(row);
    const key = storageKeyOf(row);
    await this.storage.put(key, bytes, PDF);
    await this.withTenant((tx) =>
      tx
        .update(documentFiles)
        .set({
          status: 'ready',
          fileName: modelOf(row).fileName,
          contentType: PDF,
          sizeBytes: bytes.byteLength,
          storageKey: key,
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(documentFiles.tenantId, getTenantId()),
            eq(documentFiles.id, row.id),
            ne(documentFiles.status, 'ready'),
          ),
        ),
    );
    return bytes;
  }

  private async draw(row: FileRow): Promise<Uint8Array> {
    const model = modelOf(row);
    // The logo's object, read outside any transaction. Gone from storage = a PDF without it.
    const logo =
      model.company.logo === null ? null : await this.storage.get(model.company.logo.key);
    return writeDocumentPdf(model, logo);
  }
}
