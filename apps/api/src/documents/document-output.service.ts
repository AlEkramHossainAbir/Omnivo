import { Inject, Injectable } from '@nestjs/common';
import {
  type CreatedShare,
  type DocumentEmail,
  type DocumentEmailDraft,
  type DocumentEmailInput,
  type DocumentFile,
  type DocumentShare,
  type LanguageCode,
  type OutputDocument,
  SEND_PERMISSIONS,
  SHARE_LINK_DAYS,
  whatsAppUrl,
} from '@omnivo/contracts';
import { documentEmails, documentFiles, documentShares, users } from '@omnivo/db';
import { and, desc, eq, isNull } from 'drizzle-orm';

import { AppError, notFound } from '../common/http/app-error.js';
import { emit } from '../common/outbox/outbox.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import type { Config } from '../config.js';
import { CONFIG, WITH_TENANT } from '../infra/tokens.js';
import { PermissionService } from '../rbac/permission.service.js';
import { DOCUMENT_COPY } from './copy.js';
import { DocumentFiles } from './files.js';
import { DocumentModels } from './models.service.js';
import { newShareToken } from './share-token.js';

const DAY_MS = 24 * 60 * 60 * 1000;

type EmailRow = typeof documentEmails.$inferSelect;
type ShareRow = typeof documentShares.$inferSelect;

function toEmail(row: EmailRow, sentByName: string): DocumentEmail {
  return {
    id: row.id,
    to: row.to,
    cc: row.cc,
    subject: row.subject,
    language: row.language,
    status: row.status,
    sentBy: { id: row.sentBy, name: sentByName },
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
  };
}

function toShare(row: ShareRow, createdByName: string): DocumentShare {
  return {
    id: row.id,
    language: row.language,
    createdBy: { id: row.createdBy, name: createdByName },
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    firstOpenedAt: row.firstOpenedAt?.toISOString() ?? null,
    lastOpenedAt: row.lastOpenedAt?.toISOString() ?? null,
  };
}

// The eight routes behind /documents/:kind/:id (16.1): the PDF, the email and the share links of a
// quotation, an invoice, a money receipt or a credit note. Reading needs only a login (decision 10);
// sending something out needs the document's manage permission, checked here because one route
// serves four kinds (decision 9).
@Injectable()
export class DocumentOutputService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: Config,
    private readonly models: DocumentModels,
    private readonly files: DocumentFiles,
    private readonly permissions: PermissionService,
  ) {}

  async file(kind: OutputDocument, id: string, language: LanguageCode): Promise<DocumentFile> {
    const built = await this.models.build(kind, id, language);
    const row = await this.withTenant((tx) =>
      this.files.request(tx, built, currentPrincipal().userId),
    );
    return this.files.toDocumentFile(row);
  }

  // The page polls this while a file is pending. The file must belong to this document: a file id
  // from another invoice is "not found", not a way around the document in the path.
  getFile(kind: OutputDocument, id: string, fileId: string): Promise<DocumentFile> {
    return this.withTenant(async (tx) => {
      const [row] = await tx
        .select()
        .from(documentFiles)
        .where(
          and(
            eq(documentFiles.tenantId, getTenantId()),
            eq(documentFiles.id, fileId),
            eq(documentFiles.kind, kind),
            eq(documentFiles.documentId, id),
          ),
        );
      if (!row) throw notFound('Document file');
      return this.files.toDocumentFile(row);
    });
  }

  // The dialog's first values, in the language the person picked (decision 12)
  async emailDraft(
    kind: OutputDocument,
    id: string,
    language: LanguageCode,
  ): Promise<DocumentEmailDraft> {
    await this.assertCanSend(kind);
    const built = await this.models.build(kind, id, language);
    const sender = await this.withTenant((tx) => this.senderName(tx));
    const copy = DOCUMENT_COPY[language];
    return {
      to: built.recipient.email ?? '',
      subject: copy.emailSubject(built.facts, built.company.name),
      message: copy.emailMessage(built.facts, built.recipient.name, sender, built.company.name),
    };
  }

  emails(kind: OutputDocument, id: string): Promise<{ items: DocumentEmail[] }> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({ email: documentEmails, sentByName: users.fullName })
        .from(documentEmails)
        .innerJoin(users, eq(users.id, documentEmails.sentBy))
        .where(
          and(
            eq(documentEmails.tenantId, getTenantId()),
            eq(documentEmails.kind, kind),
            eq(documentEmails.documentId, id),
          ),
        )
        // UUIDv7: the newest first
        .orderBy(desc(documentEmails.id));
      return { items: rows.map((row) => toEmail(row.email, row.sentByName)) };
    });
  }

  // The row, the PDF's row and the job commit together. The worker sends it (email.handler.ts);
  // the answer says "pending", and the history shows "sent" once the mail server took it.
  async sendEmail(
    kind: OutputDocument,
    id: string,
    input: DocumentEmailInput,
  ): Promise<DocumentEmail> {
    await this.assertCanSend(kind);
    const built = await this.models.build(kind, id, input.language);
    const userId = currentPrincipal().userId;
    return this.withTenant(async (tx) => {
      const file = await this.files.request(tx, built, userId);
      const [row] = await tx
        .insert(documentEmails)
        .values({
          tenantId: getTenantId(),
          kind,
          documentId: id,
          language: input.language,
          to: input.to,
          cc: input.cc,
          subject: input.subject,
          message: input.message,
          sentBy: userId,
        })
        .returning();
      if (!row) throw new Error('Document email insert returned no row');
      await emit(tx, 'document.email_requested', { emailId: row.id, fileId: file.id });
      return toEmail(row, await this.senderName(tx));
    });
  }

  shares(kind: OutputDocument, id: string): Promise<{ items: DocumentShare[] }> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({ share: documentShares, createdByName: users.fullName })
        .from(documentShares)
        .innerJoin(users, eq(users.id, documentShares.createdBy))
        .where(
          and(
            eq(documentShares.tenantId, getTenantId()),
            eq(documentShares.kind, kind),
            eq(documentShares.documentId, id),
          ),
        )
        .orderBy(desc(documentShares.id));
      return { items: rows.map((row) => toShare(row.share, row.createdByName)) };
    });
  }

  // A new link each time (decision 13). The PDF is asked for now, so it is usually ready by the
  // time the customer taps the link.
  async createShare(
    kind: OutputDocument,
    id: string,
    language: LanguageCode,
  ): Promise<CreatedShare> {
    await this.assertCanSend(kind);
    const built = await this.models.build(kind, id, language);
    const userId = currentPrincipal().userId;
    const { token, hash } = newShareToken();
    const share = await this.withTenant(async (tx) => {
      const [row] = await tx
        .insert(documentShares)
        .values({
          tenantId: getTenantId(),
          kind,
          documentId: id,
          language,
          tokenHash: hash,
          createdBy: userId,
          expiresAt: new Date(Date.now() + SHARE_LINK_DAYS * DAY_MS),
        })
        .returning();
      if (!row) throw new Error('Document share insert returned no row');
      await this.files.request(tx, built, userId);
      return toShare(row, await this.senderName(tx));
    });
    // The app's route, not the API's: the page at /d/:token asks the public API route
    const url = `${this.config.appOrigin}/d/${token}`;
    const message = DOCUMENT_COPY[language].shareMessage(built.facts, built.company.name, url);
    return { share, url, message, whatsAppUrl: whatsAppUrl(built.recipient.phone, message) };
  }

  // Turned off once; pressing it again on an off link changes nothing and is not an error
  async revokeShare(kind: OutputDocument, id: string, shareId: string): Promise<void> {
    await this.assertCanSend(kind);
    await this.withTenant(async (tx) => {
      const ofThisDocument = and(
        eq(documentShares.tenantId, getTenantId()),
        eq(documentShares.id, shareId),
        eq(documentShares.kind, kind),
        eq(documentShares.documentId, id),
      );
      const [revoked] = await tx
        .update(documentShares)
        .set({ revokedAt: new Date() })
        .where(and(ofThisDocument, isNull(documentShares.revokedAt)))
        .returning({ id: documentShares.id });
      if (revoked) return;
      const [exists] = await tx
        .select({ id: documentShares.id })
        .from(documentShares)
        .where(ofThisDocument);
      if (!exists) throw notFound('Share link');
    });
  }

  // The same answer the PermissionGuard gives, for the permission this kind needs (decision 9)
  private async assertCanSend(kind: OutputDocument): Promise<void> {
    const permission = SEND_PERMISSIONS[kind];
    const access = await this.permissions.forPrincipal(currentPrincipal());
    if (!access?.permissions.includes(permission)) {
      throw new AppError(403, 'permission_missing', `Missing permission: ${permission}.`, {
        params: { permissions: permission },
      });
    }
  }

  // The person's name, for the email's sign-off and the history
  private async senderName(tx: Transaction): Promise<string> {
    const [user] = await tx
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, currentPrincipal().userId));
    if (!user) throw new Error('The signed-in user has no users row');
    return user.fullName;
  }
}
