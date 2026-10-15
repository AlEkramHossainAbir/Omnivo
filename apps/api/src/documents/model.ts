import { createHash } from 'node:crypto';
import { LANGUAGE_CODES } from '@omnivo/contracts';
import { z } from 'zod';

// The look of a document's PDF (step 16): every word and number the page shows, already in the
// row's language and already formatted. The API works it out (models.service.ts) and stores it on
// the document_files row; the worker draws exactly this (pdf.ts) and never reads the document
// itself. So the worker needs no sales code, and a stored file is always the drawing of the look
// its fingerprint names.

// Bump this when pdf.ts draws differently. The number is part of the fingerprint, so every look is
// drawn again (once, on its next request) instead of serving files in the old layout.
export const LAYOUT_VERSION = 1;

const pairSchema = z.object({ label: z.string(), value: z.string() });

export const documentModelSchema = z.object({
  language: z.enum(LANGUAGE_CODES),
  // "Invoice", "মানি রিসিট"
  title: z.string(),
  // "INV-2026-27-0042": the PDF's title, and the bell's text when an email fails
  number: z.string(),
  // "INV-2026-27-0042.pdf": the download's name and the email attachment's
  fileName: z.string(),
  company: z.object({
    name: z.string(),
    // The address one line per line, the BIN, the phone
    lines: z.array(z.string()),
    // The logo in storage. Its key is new for every upload, so a new logo is a new look.
    logo: z.object({ key: z.string(), contentType: z.string() }).nullable(),
  }),
  // Number, date, due date …: label and value, top right
  meta: z.array(pairSchema),
  // Who it is for: "Bill to", the name, the code, the address
  party: z.object({
    label: z.string(),
    name: z.string(),
    code: z.string(),
    lines: z.array(z.string()),
  }),
  // What a receipt says next to the party: the amount, how it was paid, the reference
  facts: z.array(pairSchema),
  // The lines (or a receipt's invoices). `width` is a share of the line, like the report export's
  // columns. `details` are the small lines under the first text column (the SKU, the batch …).
  table: z
    .object({
      columns: z.array(
        z.object({ label: z.string(), align: z.enum(['left', 'right']), width: z.number() }),
      ),
      rows: z.array(z.object({ cells: z.array(z.string()), details: z.array(z.string()) })),
    })
    .nullable(),
  // Under the table: the left-hand note ("Prices include VAT") and the sums on the right
  totals: z
    .object({
      note: z.string().nullable(),
      rows: z.array(pairSchema.extend({ strong: z.boolean() })),
    })
    .nullable(),
  // "Amount in words: Eighteen lakh … only", on money documents
  words: z.string().nullable(),
  note: pairSchema.nullable(),
  signatures: z.array(z.string()),
  // "Page {page} of {pages}", filled in by pdf.ts when the number of pages is known
  page: z.string(),
});
export type DocumentModel = z.infer<typeof documentModelSchema>;

// sha256 of the layout version and the model. JSON.stringify writes keys in the order the object
// was built, and the model is always built by the same code, so the same look gives the same
// string. It is hashed before it is stored: jsonb sorts the keys its own way, so the hash is
// never worked out again from what the database gives back.
export function fingerprintOf(model: DocumentModel): string {
  return createHash('sha256')
    .update(JSON.stringify({ layout: LAYOUT_VERSION, model }))
    .digest('hex');
}
