import { Inject, Injectable } from '@nestjs/common';
import { type Db, tenants, users } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WorkerConfig } from '../config.js';
import { CONFIG, DB } from '../infra/tokens.js';
import { MailService } from '../mail/mail.service.js';
import { welcomeEmail } from '../mail/welcome-email.js';

// Sign-up used to finish only after everything was done. Now it commits and answers at once; the
// email goes from here, a second later, and a slow mail server cannot make sign-up slow or fail.
@Injectable()
export class WelcomeEmailHandler implements EventHandler<'workspace.created'> {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: WorkerConfig,
    private readonly mail: MailService,
  ) {}

  // Not fully idempotent, and cannot be: if the process dies after the mail server took the
  // email but before the queue marks the job done, the retry sends it again. A second welcome
  // email is harmless; a lost one is not — so "at least once" is the right side to err on.
  async handle(event: OutboxEvent<'workspace.created'>): Promise<void> {
    // users and tenants are global tables (no RLS), so no tenant transaction is needed to read them
    const [user] = await this.db
      .select({ email: users.email, fullName: users.fullName, language: users.language })
      .from(users)
      .where(eq(users.id, event.payload.userId));
    const [tenant] = await this.db
      .select({ name: tenants.name, slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, getTenantId()));
    // The account or the workspace was deleted before the job ran — nobody to welcome
    if (!user || !tenant) return;

    await this.mail.send(
      welcomeEmail({
        to: user.email,
        fullName: user.fullName,
        workspaceName: tenant.name,
        workspaceSlug: tenant.slug,
        signInLink: `${this.config.appOrigin}/login`,
        language: user.language ?? 'en',
      }),
    );
  }
}
