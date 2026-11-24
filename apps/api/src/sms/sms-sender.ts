import { Inject, Injectable } from '@nestjs/common';

import { escapeHtml } from '../mail/layout.js';
import { MailService } from '../mail/mail.service.js';
import type { SmsJob } from './sms-job.js';

// Step 27a: the one way an SMS leaves Omnivo (27a's decision 8). The worker asks for SMS_SENDER,
// never for a class, so the real provider (chosen before staging sends real SMS) is one new class
// and one line in worker.module.ts.
export interface SmsSender {
  // Throws when the message was not taken; the queue then tries again (worker/sms-runner.ts)
  send(message: SmsJob): Promise<void>;
}

export const SMS_SENDER = Symbol('SMS_SENDER');

// The text as the phone would show it: its own lines, in a font that has Bangla
const PRE_STYLE = 'font: 15px/1.5 system-ui, sans-serif; white-space: pre-wrap';

// Development, CI and staging for now: each SMS is an email to Mailpit, which the team already
// opens for the invitation emails, so the code can be read there and typed into the shop. The
// address is under .invalid, a name no real mail server delivers to (RFC 2606): if this sender were
// ever left on with a real SMTP server, the messages would bounce instead of reaching a stranger.
@Injectable()
export class MailSmsSender implements SmsSender {
  constructor(@Inject(MailService) private readonly mail: MailService) {}

  async send({ to, text }: SmsJob): Promise<void> {
    await this.mail.send({
      to: `${to}@sms.invalid`,
      subject: `SMS to ${to}`,
      text,
      html: `<pre style="${PRE_STYLE}">${escapeHtml(text)}</pre>`,
    });
  }
}
