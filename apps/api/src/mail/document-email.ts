import type { LanguageCode } from '@omnivo/contracts';

import { DOCUMENT_COPY } from '../documents/copy.js';
import { emailHtml, emailText } from './layout.js';
import type { MailMessage } from './mail.service.js';

interface DocumentEmailInput {
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  // As the person wrote it in the dialog
  message: string;
  language: LanguageCode;
  company: string;
  sender: string;
  // The company's own email; null when the settings have none
  replyTo: string | null;
  file: { name: string; bytes: Uint8Array };
}

// The email a company sends with a document's PDF (step 16). The person's message comes first,
// exactly as typed (escaped by the frame). Under it, lines the person cannot change: what is
// attached and who sent it, so a customer can always tell a real invoice from a forged one, and
// how to reply.
export function documentEmail(input: DocumentEmailInput): MailMessage {
  const copy = DOCUMENT_COPY[input.language];
  const body = {
    language: input.language,
    heading: input.company,
    intro: input.message,
    button: null,
    footer: [
      copy.emailAttached(input.file.name),
      copy.emailSentBy(input.sender, input.company),
      // Without a company email the reply would go to our no-reply address: better to say nothing
      ...(input.replyTo === null ? [] : [copy.emailReply(input.company)]),
    ],
  };
  return {
    to: input.to,
    cc: input.cc,
    fromName: `${input.company} via Omnivo`,
    ...(input.replyTo !== null && { replyTo: input.replyTo }),
    subject: input.subject,
    text: emailText(body),
    html: emailHtml(body),
    attachments: [
      {
        filename: input.file.name,
        content: Buffer.from(input.file.bytes),
        contentType: 'application/pdf',
      },
    ],
  };
}
