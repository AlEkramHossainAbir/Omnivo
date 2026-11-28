import { Inject, Injectable } from '@nestjs/common';
import { EMAIL_VERIFICATION_TTL_HOURS, verifyEmailLink } from '@omnivo/contracts';
import { type Db, emailVerifications, tenants, users } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import type { WorkerConfig } from '../config.js';
import { CONFIG, DB } from '../infra/tokens.js';
import { MailService } from '../mail/mail.service.js';
import { verificationEmail } from '../mail/verification-email.js';
import { newVerificationToken } from './verification-token.js';

type Event = OutboxEvent<'account.verification_requested'>;

// Emails the link that confirms a new owner's address. Built like InvitationEmailHandler: the
// token is made HERE, right before sending, so it never sits in the outbox table, in a Redis job or
// in a backup. email_verifications and users are global tables (no RLS), so the plain connection
// reads them; the event's tenant is only the workspace the link opens.
@Injectable()
export class VerificationEmailHandler implements EventHandler<'account.verification_requested'> {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: WorkerConfig,
    private readonly mail: MailService,
  ) {}

  async handle(event: Event): Promise<void> {
    const { userId } = event.payload;
    const { token, hash } = newVerificationToken();

    // Step 1 (own transaction): check there is still something to send, and store the new hash.
    // It must commit BEFORE the email goes out: a link in someone's inbox has to work already.
    const context = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          sentAt: emailVerifications.sentAt,
          verifiedAt: emailVerifications.verifiedAt,
          emailVerified: users.emailVerified,
          email: users.email,
          fullName: users.fullName,
          language: users.language,
          workspaceName: tenants.name,
        })
        .from(emailVerifications)
        .innerJoin(users, eq(users.id, emailVerifications.userId))
        .innerJoin(tenants, eq(tenants.id, emailVerifications.tenantId))
        .where(eq(emailVerifications.userId, userId))
        // Only the row of the link: "Send the link again" at the same moment waits for us
        .for('update', { of: emailVerifications });
      // Nothing to send: the account was deleted, the address is confirmed already (the link was
      // opened, or an invitation proved it), or sent_at is set. sent_at set = a working link is
      // out already: this job ran before (a retry after a crash), or a newer request's job sent
      // one first. A second email would only kill the first link. (No row: undefined, also out.)
      if (!row || row.verifiedAt !== null || row.emailVerified || row.sentAt !== null) {
        return null;
      }

      // A fresh day from now, not from the sign-up: the day counts from the email it is in
      await tx
        .update(emailVerifications)
        .set({
          tokenHash: hash,
          expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000),
        })
        .where(eq(emailVerifications.userId, userId));
      return row;
    });
    if (!context) return;

    // Step 2: the email, outside any transaction, so a slow mail server holds no database lock.
    // If this throws, the job is retried: step 1 runs again with a new token, and this unsent
    // link simply never works.
    await this.mail.send(
      verificationEmail({
        to: context.email,
        fullName: context.fullName,
        workspaceName: context.workspaceName,
        link: verifyEmailLink(this.config.appOrigin, token),
        language: context.language ?? 'en',
      }),
    );

    // Step 3: mark it sent, only if the hash is still ours. If "Send the link again" ran while we
    // were sending, the row waits for a newer link, and must not look sent.
    await this.db
      .update(emailVerifications)
      .set({ sentAt: new Date() })
      .where(and(eq(emailVerifications.userId, userId), eq(emailVerifications.tokenHash, hash)));
  }
}
