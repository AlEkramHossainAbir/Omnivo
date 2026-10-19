import { z } from 'zod';

import { signedUrlSchema } from './attachments.js';
import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import type { PermissionKey } from './permissions.js';
import { LANGUAGE_CODES } from './preferences.js';
import { CURRENCIES } from './settings.js';

// Step 16: a document goes out to the customer as a PDF — downloaded, attached to an email, or
// behind a share link that opens without a login (sent on WhatsApp). The worker draws the PDF
// once and keeps it; a new one is drawn only when the document (or the company on its header)
// has changed since. Step 17b sends a purchase order to its supplier the same way.

// The four documents a customer receives, and the one a supplier receives (step 17b, you chose
// the whole Send menu for it). A sales order, a challan, a return and a refund stay with the
// browser's Print (step 15c).
export const OUTPUT_DOCUMENTS = [
  'quotation',
  'invoice',
  'receipt',
  'credit_note',
  'purchase_order',
] as const;
export type OutputDocument = (typeof OUTPUT_DOCUMENTS)[number];

export function isOutputDocument(value: string): value is OutputDocument {
  return OUTPUT_DOCUMENTS.some((kind) => kind === value);
}

// Sending a document out (an email, a share link) needs the permission that makes that document:
// whoever may write an invoice may send it. Reading one, and so downloading its PDF, needs no
// permission, like GET /invoices/:id. One path serves the four kinds (:kind), so the route cannot
// name one permission; the API checks this map instead (document-output.service.ts).
export const SEND_PERMISSIONS = {
  quotation: 'sales.quotation.manage',
  invoice: 'sales.invoice.manage',
  receipt: 'sales.receipt.manage',
  credit_note: 'sales.credit_note.manage',
  purchase_order: 'purchase.order.manage',
} as const satisfies Record<OutputDocument, PermissionKey>;

const languageSchema = z.enum(LANGUAGE_CODES);

// ---------------------------------------------------------------------------------------------
// The PDF

export const DOCUMENT_FILE_STATUSES = ['pending', 'ready', 'failed'] as const;
export type DocumentFileStatus = (typeof DOCUMENT_FILE_STATUSES)[number];

export const documentFileSchema = z.object({
  id: z.uuid(),
  language: languageSchema,
  status: z.enum(DOCUMENT_FILE_STATUSES),
  // "INV-2026-27-0042.pdf"; null until the worker has written it
  fileName: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  // A short-lived download link while the file is ready, else null. Signing a link is local
  // arithmetic (no call to the storage), so a page that polls this gets a fresh one each time.
  download: signedUrlSchema.nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type DocumentFile = z.infer<typeof documentFileSchema>;

// The language of the PDF. The page sends the party's document language (the customer's, or the
// supplier's for a purchase order) unless the person picked another one.
export const documentFileInputSchema = z.object({ language: languageSchema });
export type DocumentFileInput = z.infer<typeof documentFileInputSchema>;

// ---------------------------------------------------------------------------------------------
// Email

export const MAX_EMAIL_RECIPIENTS = 5;

// The To and CC boxes take a few addresses separated by commas, semicolons or spaces (as people
// paste them from a mail program). One error for the whole box, not one per address: the form
// shows errors under a field, not under the third address inside it. Duplicates are dropped.
const emailListSchema = z.string().transform((value, ctx) => {
  const list = value
    .split(/[\s,;]+/)
    .map((email) => email.toLowerCase())
    .filter((email) => email !== '');
  if (list.some((email) => !z.email().safeParse(email).success)) {
    ctx.addIssue({ code: 'custom', message: errorCode('email_invalid') });
    return z.NEVER;
  }
  const unique = [...new Set(list)];
  if (unique.length > MAX_EMAIL_RECIPIENTS) {
    ctx.addIssue({ code: 'custom', message: errorCode('email_too_many') });
    return z.NEVER;
  }
  return unique;
});

export const documentEmailInputSchema = z.object({
  to: emailListSchema.refine((list) => list.length > 0, errorCode('email_to_required')),
  cc: emailListSchema,
  subject: z.string().trim().min(1, errorCode('email_subject_required')).max(200),
  // The person's own words, above the standard lines the server adds (what is attached, from whom)
  message: z.string().trim().max(5000),
  language: languageSchema,
});
export type DocumentEmailInput = z.infer<typeof documentEmailInputSchema>;
export type DocumentEmailFormValues = z.input<typeof documentEmailInputSchema>;

// What the dialog starts with: the customer's (or supplier's) email address, and a subject and message in the
// chosen language. The server writes them (with the rest of the email and the PDF) so that every
// word the customer reads comes from one place, in the customer's language, whatever language
// the person's own screen is in.
export const documentEmailDraftQuerySchema = z.object({ language: languageSchema });

export const documentEmailDraftSchema = z.object({
  to: z.string(),
  subject: z.string(),
  message: z.string(),
});
export type DocumentEmailDraft = z.infer<typeof documentEmailDraftSchema>;

export const DOCUMENT_EMAIL_STATUSES = ['pending', 'sent', 'failed'] as const;
export type DocumentEmailStatus = (typeof DOCUMENT_EMAIL_STATUSES)[number];

// The person who sent an email or made a share link: the history says who did it
const personSchema = z.object({ id: z.uuid(), name: z.string() });

export const documentEmailSchema = z.object({
  id: z.uuid(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  language: languageSchema,
  status: z.enum(DOCUMENT_EMAIL_STATUSES),
  sentBy: personSchema,
  createdAt: z.iso.datetime(),
  // When the mail server took it; null while pending or after it failed
  sentAt: z.iso.datetime().nullable(),
});
export type DocumentEmail = z.infer<typeof documentEmailSchema>;

// The whole history, newest first. No paging: a document is emailed a handful of times.
export const documentEmailListSchema = z.object({ items: z.array(documentEmailSchema) });

// ---------------------------------------------------------------------------------------------
// Share links

// How long a link works. Long enough for a customer to open it again when the payment is due
// (most payment terms are 30 days or less); a new link can always be made.
export const SHARE_LINK_DAYS = 30;

// The token in a link: 16 random bytes in base64url, 22 characters. 128 bits cannot be guessed,
// and the link stays short in a WhatsApp message. The database keeps only its hash.
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export const documentShareSchema = z.object({
  id: z.uuid(),
  language: languageSchema,
  createdBy: personSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  // When the customer first and last opened it; null until they do
  firstOpenedAt: z.iso.datetime().nullable(),
  lastOpenedAt: z.iso.datetime().nullable(),
});
export type DocumentShare = z.infer<typeof documentShareSchema>;

export const documentShareListSchema = z.object({ items: z.array(documentShareSchema) });

export const documentShareInputSchema = z.object({ language: languageSchema });
export type DocumentShareInput = z.infer<typeof documentShareInputSchema>;

// Only the answer to "make a link" has the link itself: the server keeps the token's hash, so a
// link cannot be shown again later (the person makes a new one). The message is the customer's
// text with the link in it; whatsAppUrl opens WhatsApp with that text, to the customer's number
// when the server could read one from the customer's phone.
export const createdShareSchema = z.object({
  share: documentShareSchema,
  url: z.url(),
  message: z.string(),
  whatsAppUrl: z.url(),
});
export type CreatedShare = z.infer<typeof createdShareSchema>;

// The number WhatsApp wants: the country code and the number, digits only. A phone is free text
// in Omnivo ("01711-000000", "+880 1711 000000", "008801711000000"), so this reads the common
// shapes and returns null for anything else — WhatsApp then lets the person pick the contact.
export function whatsAppNumber(phone: string | null): string | null {
  if (phone === null) return null;
  const digits = phone.replace(/\D/g, '');
  const international = phone.trim().startsWith('+')
    ? digits
    : digits.startsWith('00')
      ? digits.slice(2)
      : null;
  if (international !== null) return /^[1-9]\d{7,14}$/.test(international) ? international : null;
  // A Bangladeshi mobile number as people write it: 01 and nine more digits
  if (/^01\d{9}$/.test(digits)) return `88${digits}`;
  if (/^8801\d{9}$/.test(digits)) return digits;
  return null;
}

// https://wa.me/8801711000000?text=… (or https://wa.me/?text=… without a number)
export function whatsAppUrl(phone: string | null, text: string): string {
  return `https://wa.me/${whatsAppNumber(phone) ?? ''}?text=${encodeURIComponent(text)}`;
}

// ---------------------------------------------------------------------------------------------
// The public page behind a link

// What the customer (or the supplier) sees before downloading: enough to know what the file is
// and from whom. Only an invoice has a due date and an amount still due.
export const publicDocumentSchema = z.object({
  company: z.string(),
  logoUrl: z.url().nullable(),
  // z.string(), not the enum: a newer server's fifth kind must not break an older page. The page
  // narrows it with isOutputDocument().
  kind: z.string(),
  number: z.string(),
  date: z.iso.date(),
  // Who it was sent to: the customer, or the supplier of a purchase order (named "customer" until
  // step 17b)
  recipient: z.string(),
  total: z.string(),
  currency: z.enum(CURRENCIES),
  dueDate: z.iso.date().nullable(),
  amountDue: z.string().nullable(),
  language: languageSchema,
  // The PDF in the link's language. Pending the first time a link is opened (or after the
  // document changed): the page asks again until it is ready.
  file: documentFileSchema,
});
export type PublicDocument = z.infer<typeof publicDocumentSchema>;

// ---------------------------------------------------------------------------------------------
// Routes

const documentParamsSchema = z.object({ kind: z.enum(OUTPUT_DOCUMENTS), id: z.uuid() });

export const documentOutputRoutes = {
  // The PDF in a language: the one already made when the document has not changed since, else a
  // new one the worker draws. 200 either way: the answer says whether it is ready.
  file: defineRoute({
    method: 'POST',
    path: '/documents/:kind/:id/files',
    summary: 'Get the PDF of a document that goes out, made now if needed',
    auth: 'bearer',
    status: 200,
    params: documentParamsSchema,
    body: documentFileInputSchema,
    response: documentFileSchema,
  }),
  // The page asks this every couple of seconds until the file is ready or failed
  getFile: defineRoute({
    method: 'GET',
    path: '/documents/:kind/:id/files/:fileId',
    summary: 'One PDF of a document, with a download link when it is ready',
    auth: 'bearer',
    status: 200,
    params: documentParamsSchema.extend({ fileId: z.uuid() }),
    response: documentFileSchema,
  }),
  emailDraft: defineRoute({
    method: 'GET',
    path: '/documents/:kind/:id/email-draft',
    summary:
      "The email dialog's first values in a language (needs the document's manage permission)",
    auth: 'bearer',
    status: 200,
    params: documentParamsSchema,
    query: documentEmailDraftQuerySchema,
    response: documentEmailDraftSchema,
  }),
  emails: defineRoute({
    method: 'GET',
    path: '/documents/:kind/:id/emails',
    summary: 'The emails a document was sent in, newest first',
    auth: 'bearer',
    status: 200,
    params: documentParamsSchema,
    response: documentEmailListSchema,
  }),
  sendEmail: defineRoute({
    method: 'POST',
    path: '/documents/:kind/:id/emails',
    summary: "Email a document's PDF (needs the document's manage permission)",
    auth: 'bearer',
    status: 201,
    params: documentParamsSchema,
    body: documentEmailInputSchema,
    response: documentEmailSchema,
  }),
  shares: defineRoute({
    method: 'GET',
    path: '/documents/:kind/:id/shares',
    summary: "A document's share links, newest first",
    auth: 'bearer',
    status: 200,
    params: documentParamsSchema,
    response: documentShareListSchema,
  }),
  createShare: defineRoute({
    method: 'POST',
    path: '/documents/:kind/:id/shares',
    summary:
      "Make a link that opens a document's PDF without a login (needs the manage permission)",
    auth: 'bearer',
    status: 201,
    params: documentParamsSchema,
    body: documentShareInputSchema,
    response: createdShareSchema,
  }),
  // POST, not DELETE: the link stays in the history, turned off
  revokeShare: defineRoute({
    method: 'POST',
    path: '/documents/:kind/:id/shares/:shareId/revoke',
    summary: 'Turn a share link off (needs the manage permission)',
    auth: 'bearer',
    status: 204,
    params: documentParamsSchema.extend({ shareId: z.uuid() }),
    response: z.void(),
  }),
};

export const publicDocumentRoutes = {
  get: defineRoute({
    method: 'GET',
    path: '/public/documents/:token',
    summary: 'The document behind a share link, and its PDF (no login)',
    auth: 'public',
    status: 200,
    params: z.object({ token: z.string().regex(SHARE_TOKEN_PATTERN) }),
    response: publicDocumentSchema,
  }),
};
