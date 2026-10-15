import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport } from 'nodemailer';

import { CONFIG } from '../infra/tokens.js';

export interface MailMessage {
  to: string | readonly string[];
  // Step 16: a document email can copy a few more people in
  cc?: readonly string[];
  // Step 16: an email a company sends shows its name ("Rahman Textiles via Omnivo"), still from our
  // own address: mail servers trust only a domain that is ours (SPF, DKIM), and an email "from"
  // the customer's own domain would land in spam or be refused.
  fromName?: string;
  // Where the customer's reply goes: the company's own email, never our no-reply address
  replyTo?: string;
  subject: string;
  // দুটোই: HTML না দেখানো মেইল-অ্যাপ (আর স্প্যাম ফিল্টার) শুধু-লেখার অংশ পড়ে
  text: string;
  html: string;
  attachments?: readonly { filename: string; content: Buffer; contentType: string }[];
}

// Only the part of the config this service reads. The worker's CONFIG is a WorkerConfig, and a
// narrow type lets the service accept it without knowing about the rest.
interface MailConfig {
  mail: { url: string; from: string };
}

// SMTP-র একমাত্র জায়গা। dev-এ Mailpit, production-এ আসল SMTP — কোড একই, শুধু SMTP_URL আলাদা।
// Since step 8 only the worker uses it: the API never talks to the mail server during a request.
@Injectable()
export class MailService implements OnApplicationShutdown {
  private readonly transport: ReturnType<typeof createTransport>;
  private readonly from: string;
  // The address part of MAIL_FROM ("Omnivo <no-reply@omnivo.app>" → "no-reply@omnivo.app"), for
  // an email that goes out under another display name
  private readonly fromAddress: string;

  constructor(@Inject(CONFIG) config: MailConfig) {
    this.from = config.mail.from;
    this.fromAddress = /<([^<>]+)>\s*$/.exec(config.mail.from)?.[1] ?? config.mail.from.trim();
    // nodemailer's default connection timeout is 2 minutes. A job holds its queue lock for 30
    // seconds (BullMQ's lockDuration), so a slow mail server must fail well before that; the
    // queue then retries the job instead of thinking the worker died.
    this.transport = createTransport({
      url: config.mail.url,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
  }

  // Throws when the mail server does not take the message. The queue catches that and runs the
  // job again later — that is the whole retry mechanism, so nothing is swallowed here. Never log
  // the address or the body: an invitation email carries a link that lets you into a workspace.
  async send(message: MailMessage): Promise<void> {
    const { fromName, to, cc, attachments, ...rest } = message;
    await this.transport.sendMail({
      ...rest,
      // The object form: nodemailer quotes a name with a comma or quotes in it ("Rahman & Sons,
      // Ltd."), which a hand-built "Name <address>" string would break
      from: fromName === undefined ? this.from : { name: fromName, address: this.fromAddress },
      to: typeof to === 'string' ? to : [...to],
      ...(cc !== undefined && cc.length > 0 && { cc: [...cc] }),
      ...(attachments !== undefined && { attachments: [...attachments] }),
    });
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }
}
