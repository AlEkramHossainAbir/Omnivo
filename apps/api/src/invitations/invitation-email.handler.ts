import { Inject, Injectable } from '@nestjs/common';
import { invitationLink } from '@omnivo/contracts';
import { invitations, tenants, users } from '@omnivo/db';
import { and, eq, gt, isNull } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import type { WorkerConfig } from '../config.js';
import { CONFIG, WITH_TENANT } from '../infra/tokens.js';
import { invitationEmail } from '../mail/invitation-email.js';
import { MailService } from '../mail/mail.service.js';
import { notify } from '../notifications/notify.js';
import { newInvitationToken } from './invitation-token.js';

type Event = OutboxEvent<'invitation.issued'>;

// Sends the invitation email. The link's token is made HERE, right before sending — so the token
// never sits in the outbox table, in a Redis job or in a backup. Only its hash is stored, as
// before (step 7).
@Injectable()
export class InvitationEmailHandler implements EventHandler<'invitation.issued'> {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: WorkerConfig,
    private readonly mail: MailService,
  ) {}

  async handle(event: Event): Promise<void> {
    const tenantId = getTenantId();
    const { token, hash } = newInvitationToken();

    // Step 1 (own transaction): check there is still something to send, and store the new hash.
    // It must commit BEFORE the email goes out: a link in someone's inbox has to work already.
    const context = await this.withTenant(async (tx) => {
      const [row] = await tx
        .select({
          email: invitations.email,
          sentAt: invitations.sentAt,
          workspaceName: tenants.name,
        })
        .from(invitations)
        .innerJoin(tenants, eq(tenants.id, invitations.tenantId))
        .where(
          and(
            eq(invitations.tenantId, tenantId),
            eq(invitations.id, event.payload.invitationId),
            // Still open: accepted, cancelled or expired invitations get no email
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
            gt(invitations.expiresAt, new Date()),
          ),
        )
        // Only the invitation row, not tenants: a resend at the same moment waits for us
        .for('update', { of: invitations });
      // sentAt set = a working link is already out. That covers two cases: this job ran before
      // (retry after a crash), or an invitation was resent twice quickly and the first job already
      // sent the fresh link. Either way, a second email would only kill the first link.
      // (No row at all — accepted, cancelled or expired — also ends here: undefined !== null.)
      if (row?.sentAt !== null) return null;

      await tx
        .update(invitations)
        .set({ tokenHash: hash, sendFailedAt: null })
        .where(
          and(eq(invitations.tenantId, tenantId), eq(invitations.id, event.payload.invitationId)),
        );

      const [inviter] = await tx
        .select({ fullName: users.fullName, language: users.language })
        .from(users)
        .where(eq(users.id, event.payload.actorUserId));
      return { ...row, inviter };
    });
    if (!context) return;

    // Step 2: the email, outside any transaction — a slow mail server holds no database lock.
    // If this throws, the job is retried: step 1 runs again with a new token, and this unsent
    // link simply never works.
    await this.mail.send(
      invitationEmail({
        to: context.email,
        workspaceName: context.workspaceName,
        inviterName: context.inviter?.fullName ?? context.workspaceName,
        link: invitationLink(this.config.appOrigin, token),
        language: context.inviter?.language ?? 'en',
      }),
    );

    // Step 3: mark it sent — only if the hash is still ours. If someone pressed Resend while we
    // were sending, the row now waits for a different link, and must not look "sent".
    await this.withTenant((tx) =>
      tx
        .update(invitations)
        .set({ sentAt: new Date() })
        .where(
          and(
            eq(invitations.tenantId, tenantId),
            eq(invitations.id, event.payload.invitationId),
            eq(invitations.tokenHash, hash),
          ),
        ),
    );
  }

  // After the last retry: the team page shows "Email not sent", and the person who sent it hears
  // about it in the bell — they may have closed the page long ago.
  async onGiveUp(event: Event): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      const [failed] = await tx
        .update(invitations)
        .set({ sendFailedAt: new Date() })
        .where(
          and(
            eq(invitations.tenantId, tenantId),
            eq(invitations.id, event.payload.invitationId),
            isNull(invitations.sentAt),
          ),
        )
        .returning({ email: invitations.email });
      if (!failed) return;
      await notify(tx, {
        userId: event.payload.actorUserId,
        type: 'invitation.failed',
        params: { email: failed.email },
        eventId: event.id,
      });
    });
  }
}
