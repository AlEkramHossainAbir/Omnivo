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
const messageSchema = z.object({ Text: z.string(), HTML: z.string() });

export interface Mail {
  subject: string;
  text: string;
  html: string;
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
  return { subject: found.Subject, text: message.Text, html: message.HTML };
}

export function invitationTokenOf(mail: Mail): string {
  const token = /http:\/\/localhost:5173\/invite#([\w-]+)/.exec(mail.text)?.[1];
  if (!token) throw new Error('no invitation link in the mail');
  return token;
}
