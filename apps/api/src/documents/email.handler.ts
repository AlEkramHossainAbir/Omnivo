import { Inject, Injectable } from '@nestjs/common';
import { documentEmails, tenantSettings, users } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import { type EventHandler, type OutboxEvent, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { documentEmail } from '../mail/document-email.js';
import { MailService } from '../mail/mail.service.js';
import { notify } from '../notifications/notify.js';
import { DocumentFileMaker, modelOf } from './file-maker.js';

type Event = OutboxEvent<'document.email_requested'>;

// Sends a document email with its PDF attached (step 16). The PDF is drawn here when it is not
// ready yet, rather than waiting on the file job in the other queue: the email never waits for a
// job that may be stuck behind a big import.
@Injectable()
export class DocumentEmailHandler implements EventHandler<'document.email_requested'> {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly mail: MailService,
    private readonly maker: DocumentFileMaker,
  ) {}

  async handle(event: Event): Promise<void> {
    const tenantId = getTenantId();
    // 1) What to send, who sent it, and where replies go, in one short transaction
    const context = await this.withTenant(async (tx) => {
      const [email] = await tx
        .select({ email: documentEmails, sender: users.fullName })
        .from(documentEmails)
        .innerJoin(users, eq(users.id, documentEmails.sentBy))
        .where(
          and(eq(documentEmails.tenantId, tenantId), eq(documentEmails.id, event.payload.emailId)),
        );
      if (!email) throw new PermanentJobError('The document email no longer exists');
      // Sent already (this job ran before) or given up: nothing to do
      if (email.email.status !== 'pending') return null;
      const [settings] = await tx
        .select({ email: tenantSettings.email })
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tenantId));
      return { ...email, replyTo: settings?.email ?? null };
    });
    if (!context) return;

    // 2) The PDF, then the email, outside any transaction: drawing and a slow mail server hold no
    //    database lock. If sending throws, the queue tries again later.
    const file = await this.maker.load(event.payload.fileId);
    const model = modelOf(file);
    const bytes = await this.maker.bytes(file);
    const { email } = context;
    await this.mail.send(
      documentEmail({
        to: email.to,
        cc: email.cc,
        subject: email.subject,
        message: email.message,
        language: email.language,
        // The name on the PDF's header, so the email and its attachment say the same company
        company: model.company.name,
        sender: context.sender,
        replyTo: context.replyTo,
        file: { name: model.fileName, bytes },
      }),
    );

    // 3) Sent. A crash between 2 and 3 sends the email again on the retry: the customer may get it
    //    twice, which is better than never (the mail server gives no way to ask "did it arrive?").
    await this.withTenant((tx) =>
      tx
        .update(documentEmails)
        .set({ status: 'sent', sentAt: new Date() })
        .where(
          and(
            eq(documentEmails.tenantId, tenantId),
            eq(documentEmails.id, email.id),
            eq(documentEmails.status, 'pending'),
          ),
        ),
    );
  }

  // After the last retry: the history says "Failed", and the person who pressed Send hears it in
  // the bell (decision 6): they have probably left the page.
  async onGiveUp(event: Event): Promise<void> {
    const tenantId = getTenantId();
    // The document's number for the bell's text, from the PDF's model. A row this worker cannot
    // read still fails the email; the bell then says only which kind of document.
    const number = await this.maker
      .load(event.payload.fileId)
      .then((file) => modelOf(file).number)
      .catch(() => '');
    await this.withTenant(async (tx) => {
      const [failed] = await tx
        .update(documentEmails)
        .set({ status: 'failed' })
        .where(
          and(
            eq(documentEmails.tenantId, tenantId),
            eq(documentEmails.id, event.payload.emailId),
            eq(documentEmails.status, 'pending'),
          ),
        )
        .returning({
          sentBy: documentEmails.sentBy,
          kind: documentEmails.kind,
          documentId: documentEmails.documentId,
        });
      if (!failed) return;
      await notify(tx, {
        userId: failed.sentBy,
        type: 'document.email_failed',
        // id: a click on the bell opens the document's page
        params: { document: failed.kind, id: failed.documentId, number },
        eventId: event.id,
      });
    });
  }
}
