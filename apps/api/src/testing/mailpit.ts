import { z } from 'zod';

// Mailpit-এর HTTP API — বাইরের ডেটা, তাই schema দিয়ে পড়া (cast না)
const mailboxSchema = z.object({
  messages: z.array(
    z.object({
      ID: z.string(),
      Subject: z.string(),
      To: z.array(z.object({ Address: z.string() })),
    }),
  ),
});
// Mailpit writes an empty address list as null or [], depending on the header
const addressesSchema = z
  .array(z.object({ Address: z.string() }))
  .nullable()
  .transform((list) => (list ?? []).map((item) => item.Address));
const messageSchema = z.object({
  // SMTP ends lines with \r\n; the tests write \n
  Text: z.string().transform((text) => text.replaceAll('\r\n', '\n')),
  HTML: z.string(),
  From: z.object({ Name: z.string(), Address: z.string() }),
  Cc: addressesSchema,
  ReplyTo: addressesSchema,
  Attachments: z
    .array(z.object({ PartID: z.string(), FileName: z.string(), ContentType: z.string() }))
    .nullable()
    .transform((list) => list ?? []),
});

export interface Mail {
  id: string;
  subject: string;
  text: string;
  html: string;
  from: { name: string; address: string };
  cc: string[];
  replyTo: string[];
  attachments: { partId: string; fileName: string; contentType: string }[];
}

// The newest email to this address (Mailpit lists newest first). Throws when there is none yet —
// wrap it in eventually(): the worker sends a moment after the request has answered.
export async function lastMailTo(apiUrl: string, address: string): Promise<Mail> {
  const mailbox = mailboxSchema.parse(await (await fetch(`${apiUrl}/api/v1/messages`)).json());
  const found = mailbox.messages.find((message) => message.To.some((to) => to.Address === address));
  if (!found) throw new Error(`no mail to ${address}`);
  const message = messageSchema.parse(
    await (await fetch(`${apiUrl}/api/v1/message/${found.ID}`)).json(),
  );
  return {
    id: found.ID,
    subject: found.Subject,
    text: message.Text,
    html: message.HTML,
    from: { name: message.From.Name, address: message.From.Address },
    cc: message.Cc,
    replyTo: message.ReplyTo,
    attachments: message.Attachments.map((item) => ({
      partId: item.PartID,
      fileName: item.FileName,
      contentType: item.ContentType,
    })),
  };
}

// The bytes of one attachment, as the customer's mail program would save it
export async function attachmentOf(
  apiUrl: string,
  mail: Mail,
  partId: string,
): Promise<Uint8Array> {
  const res = await fetch(`${apiUrl}/api/v1/message/${mail.id}/part/${partId}`);
  if (!res.ok) throw new Error(`no part ${partId} in mail ${mail.id}`);
  return new Uint8Array(await res.arrayBuffer());
}

export function invitationTokenOf(mail: Mail): string {
  const token = /http:\/\/localhost:5173\/invite#([\w-]+)/.exec(mail.text)?.[1];
  if (!token) throw new Error('no invitation link in the mail');
  return token;
}
