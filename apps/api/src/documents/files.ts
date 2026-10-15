import { Injectable } from '@nestjs/common';
import type { DocumentFile } from '@omnivo/contracts';
import { documentFiles } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import { emit } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { StorageService } from '../storage/storage.service.js';
import type { BuiltDocument } from './models.service.js';

export type FileRow = typeof documentFiles.$inferSelect;

// Where the worker stores a file. Fixed by the row's id, so a job that runs twice writes the same
// object, and a key never says more than the document it belongs to.
export function storageKeyOf(row: Pick<FileRow, 'tenantId' | 'kind' | 'documentId' | 'id'>) {
  return ['tenants', row.tenantId, 'documents', row.kind, row.documentId, `${row.id}.pdf`].join(
    '/',
  );
}

// The API's half of a PDF (decisions 5, 18, 19): find the row of this look, or make it and ask
// the worker to draw it. Used by the download, the email, the share link and the public page.
@Injectable()
export class DocumentFiles {
  constructor(private readonly storage: StorageService) {}

  // Call it inside the caller's transaction, so the row, its job and whatever the caller writes
  // (an email, a share link) commit together. requestedBy is null on the public page.
  async request(
    tx: Transaction,
    built: BuiltDocument,
    requestedBy: string | null,
  ): Promise<FileRow> {
    const tenantId = getTenantId();
    const look = and(
      eq(documentFiles.tenantId, tenantId),
      eq(documentFiles.kind, built.kind),
      eq(documentFiles.documentId, built.id),
      eq(documentFiles.language, built.model.language),
      eq(documentFiles.fingerprint, built.fingerprint),
    );
    // Two clicks at the same moment: the second insert waits for the first and then does nothing
    // (document_files_look_idx), so there is one row and one job
    const [inserted] = await tx
      .insert(documentFiles)
      .values({
        tenantId,
        kind: built.kind,
        documentId: built.id,
        language: built.model.language,
        fingerprint: built.fingerprint,
        model: built.model,
        requestedBy,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      await emit(tx, 'document.file_requested', { fileId: inserted.id });
      return inserted;
    }
    const [row] = await tx.select().from(documentFiles).where(look);
    if (!row)
      throw new Error(`Document file of ${built.kind} ${built.id} vanished after a conflict`);
    if (row.status !== 'failed') return row;
    // Decision 19: a failed look is tried again on the same row. `status = 'failed'` in the WHERE:
    // when two requests retry at once, only one of them starts a new job.
    const [retried] = await tx
      .update(documentFiles)
      .set({ status: 'pending', finishedAt: null })
      .where(and(eq(documentFiles.id, row.id), eq(documentFiles.status, 'failed')))
      .returning();
    if (!retried) {
      const [current] = await tx.select().from(documentFiles).where(eq(documentFiles.id, row.id));
      return current ?? row;
    }
    await emit(tx, 'document.file_requested', { fileId: retried.id });
    return retried;
  }

  // The answer the page reads. A ready file carries a fresh download link: signing is local
  // arithmetic, so a page that polls gets one each time at no cost (16.1).
  async toDocumentFile(row: FileRow): Promise<DocumentFile> {
    // The check constraint makes the three present whenever the status is 'ready'
    const download =
      row.status === 'ready' &&
      row.storageKey !== null &&
      row.contentType !== null &&
      row.fileName !== null
        ? await this.signedDownload(row.storageKey, row.contentType, row.fileName)
        : null;
    return {
      id: row.id,
      language: row.language,
      status: row.status,
      fileName: row.fileName,
      sizeBytes: row.sizeBytes,
      download,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    };
  }

  private async signedDownload(key: string, contentType: string, fileName: string) {
    const signed = await this.storage.downloadUrl(key, contentType, fileName);
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }
}
