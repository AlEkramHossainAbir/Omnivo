import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport } from 'nodemailer';

import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';

export interface MailMessage {
  to: string;
  subject: string;
  // দুটোই: HTML না দেখানো মেইল-অ্যাপ (আর স্প্যাম ফিল্টার) শুধু-লেখার অংশ পড়ে
  text: string;
  html: string;
}

// SMTP-র একমাত্র জায়গা। dev-এ Mailpit, production-এ আসল SMTP — কোড একই, শুধু SMTP_URL আলাদা।
// ধাপ ৮-এ পাঠানো সরবে worker-এ (outbox থেকে); তখনো এই service-ই পাঠাবে, শুধু ডাকবে worker
@Injectable()
export class MailService implements OnApplicationShutdown {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: ReturnType<typeof createTransport>;
  private readonly from: string;

  constructor(@Inject(CONFIG) config: Config) {
    this.from = config.mail.from;
    // nodemailer-এর ডিফল্ট connectionTimeout ২ মিনিট — mail server বন্ধ থাকলে "Invite" বাটন দুই মিনিট
    // ঘুরত। এখন request-এর ভেতরে পাঠানো হয়, তাই কয়েক সেকেন্ডেই হার মানা
    this.transport = createTransport({
      url: config.mail.url,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
  }

  // true = SMTP সার্ভার চিঠিটা নিয়েছে। false = নেয়নি — throw না: চিঠি না গেলেও invitation তৈরি হয়ে গেছে
  // (commit), caller সেটা "পাঠানো হয়নি" হিসেবে জানায়। লগে ঠিকানা বা লিংক না — লিংকে token থাকে
  async send(message: MailMessage): Promise<boolean> {
    try {
      await this.transport.sendMail({ from: this.from, ...message });
      return true;
    } catch (error) {
      this.logger.warn(`sending "${message.subject}" failed: ${String(error)}`);
      return false;
    }
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }
}
