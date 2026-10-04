import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateProductImportInput,
  ProductImport,
  ProductImportDetail,
} from '@omnivo/contracts';
import { productImports, users } from '@omnivo/db';
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';

import { AppError, notFound } from '../common/http/app-error.js';
import { emit } from '../common/outbox/outbox.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { StorageService } from '../storage/storage.service.js';

// Ten minutes to upload, like an attachment: plenty for 5 MB on a slow line
const UPLOAD_TTL_SECONDS = 10 * 60;
// The browser must send exactly this type; Windows reports a .csv as application/vnd.ms-excel,
// so the type is fixed here instead of taken from the browser
const CSV_TYPE = 'text/csv';

type ImportRow = typeof productImports.$inferSelect;

function toImport(row: ImportRow, fullName: string): ProductImport {
  return {
    id: row.id,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    status: row.status,
    rowCount: row.rowCount,
    productCount: row.productCount,
    errorCount: row.errorCount,
    requestedBy: { id: row.requestedBy, fullName },
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

const cursorSchema = z.tuple([z.uuid()]);

// The API's half of an import: the row, the upload address, and the outbox event once the file is
// really in storage. The worker does the rest (import.handler.ts).
@Injectable()
export class ProductImportsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
  ) {}

  create(input: CreateProductImportInput) {
    const tenantId = getTenantId();
    const principal = currentPrincipal();
    return this.withTenant(async (tx) => {
      const [row] = await tx
        .insert(productImports)
        .values({
          tenantId,
          requestedBy: principal.userId,
          fileName: input.fileName,
          sizeBytes: input.sizeBytes,
          // The key is fixed before the row exists, so it can hold no id; a random part keeps two
          // uploads of the same name apart
          storageKey: ['tenants', tenantId, 'product-imports', `${randomUUID()}.csv`].join('/'),
        })
        .returning();
      if (!row) throw new Error('Product import insert returned no row');
      const upload = await this.storage.uploadUrl(row.storageKey, CSV_TYPE, UPLOAD_TTL_SECONDS);
      return {
        import: toImport(row, await this.nameOf(tx, row.requestedBy)),
        upload: {
          method: 'PUT' as const,
          url: upload.url,
          headers: { 'content-type': CSV_TYPE },
          expiresAt: upload.expiresAt.toISOString(),
        },
      };
    });
  }

  // The browser says "uploaded"; storage is asked rather than believed. Then, in the same
  // transaction as the status change, the outbox event (step 8): queued exactly once.
  start(id: string): Promise<ProductImport> {
    return this.withTenant(async (tx) => {
      const [row] = await tx
        .select()
        .from(productImports)
        .where(and(eq(productImports.tenantId, getTenantId()), eq(productImports.id, id)))
        .for('update');
      if (!row) throw notFound('Product import');
      if (row.status !== 'uploading') {
        throw new AppError(409, 'import_not_pending', 'This import was started already.');
      }
      const stored = await this.storage.head(row.storageKey);
      // A presigned PUT cannot limit the size (attachments.service.ts): checked here instead
      if (stored?.sizeBytes !== row.sizeBytes) {
        throw new AppError(409, 'import_not_uploaded', "The file isn't in storage, or it differs.");
      }
      const [queued] = await tx
        .update(productImports)
        .set({ status: 'queued' })
        .where(eq(productImports.id, id))
        .returning();
      if (!queued) throw notFound('Product import');
      await emit(tx, 'product.import_requested', { importId: id });
      return toImport(queued, await this.nameOf(tx, queued.requestedBy));
    });
  }

  list(query: { limit: number; cursor?: string | undefined }) {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({ row: productImports, fullName: users.fullName })
        .from(productImports)
        .innerJoin(users, eq(users.id, productImports.requestedBy))
        .where(
          and(
            eq(productImports.tenantId, getTenantId()),
            after === undefined ? undefined : lt(productImports.id, after[0]),
          ),
        )
        .orderBy(desc(productImports.id))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (last) => [last.row.id]);
      return {
        items: page.items.map(({ row, fullName }) => toImport(row, fullName)),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<ProductImportDetail> {
    return this.withTenant(async (tx) => {
      const [found] = await tx
        .select({ row: productImports, fullName: users.fullName })
        .from(productImports)
        .innerJoin(users, eq(users.id, productImports.requestedBy))
        .where(and(eq(productImports.tenantId, getTenantId()), eq(productImports.id, id)));
      if (!found) throw notFound('Product import');
      return { ...toImport(found.row, found.fullName), errors: found.row.errors };
    });
  }

  private async nameOf(tx: Transaction, userId: string): Promise<string> {
    const [user] = await tx
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, userId));
    return user?.fullName ?? '';
  }
}
