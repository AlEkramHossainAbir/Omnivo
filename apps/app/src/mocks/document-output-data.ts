import {
  amountDueOf,
  type CreatedShare,
  type DocumentEmail,
  type DocumentEmailDraft,
  type DocumentEmailInput,
  type DocumentFile,
  type DocumentShare,
  type LanguageCode,
  type OutputDocument,
  type PublicDocument,
  SHARE_LINK_DAYS,
  todayIn,
  whatsAppUrl,
} from '@omnivo/contracts';
import { formatDate, formatMoney, formatNumber } from '@omnivo/i18n';

import { OWNER } from './fixtures';
import { findInvoice, findReceipt, toInvoice, toReceipt } from './invoice-data';
import { MockProblem } from './mock';
import { findCreditNote, toCreditNote } from './return-data';
import { findCustomer } from './sales-data';
import { findQuotation, toQuotation } from './sales-document-data';
import type { WorkspaceData } from './workspace-data';

// Step 16 on the mock's arrays: the PDFs, the emails and the share links of a quotation, an
// invoice, a money receipt and a credit note, with the API's rules, shortened. There is no worker:
// like an export (report-data.ts), a file or an email "finishes" on the first read after its delay.

// Shorter than the Send menu's 1.5 s wait, so its first poll finds the file ready
const FILE_DELAY_MS = 1_200;
// Shorter than the history's 3 s poll, but long enough that the list shows "Sending" first
const EMAIL_DELAY_MS = 2_500;

export interface MockDocumentFile extends DocumentFile {
  kind: OutputDocument;
  documentId: string;
  // The file's name once it is made: only the number, as in the API, so both languages are
  // "QT-2026-27-0003.pdf"
  name: string;
  // What the PDF shows (the API's fingerprint): when the document changes, so does this, and the
  // next request makes a new file
  look: string;
  readyAt: number;
}

export interface MockDocumentEmail extends DocumentEmail {
  kind: OutputDocument;
  documentId: string;
  number: string;
  sendsAt: number;
}

export interface MockDocumentShare extends DocumentShare {
  kind: OutputDocument;
  documentId: string;
}

export interface MockDocumentOutput {
  files: MockDocumentFile[];
  // Newest first, like the API's lists
  emails: MockDocumentEmail[];
  shares: MockDocumentShare[];
}

export function emptyDocumentOutput(): MockDocumentOutput {
  return { files: [], emails: [], shares: [] };
}

// ---------------------------------------------------------------------------------------------
// The document

// What the PDF, the email and the link need to know about a document
interface Issued {
  number: string;
  date: string;
  customerId: string;
  total: string;
  // The quotation's "valid until" or the invoice's due date, named in the email's first message
  until: string | null;
  dueDate: string | null;
  amountDue: string | null;
  // A credit note's invoice
  invoice: string | null;
}

// The API's 409: only a numbered document goes out (decision 11)
function notIssued(): never {
  throw new MockProblem(409, 'document_not_issued');
}

// Each find…() throws not_found (404) for a document this workspace does not have
function issuedOf(data: WorkspaceData, kind: OutputDocument, id: string): Issued {
  switch (kind) {
    case 'quotation': {
      const doc = toQuotation(data, findQuotation(data, id));
      return {
        number: doc.number,
        date: doc.date,
        customerId: doc.customer.id,
        total: doc.total,
        until: doc.validUntil,
        dueDate: null,
        amountDue: null,
        invoice: null,
      };
    }
    case 'invoice': {
      const doc = toInvoice(data, findInvoice(data, id));
      if (doc.number === null) return notIssued();
      return {
        number: doc.number,
        date: doc.date,
        customerId: doc.customer.id,
        total: doc.total,
        until: doc.dueDate,
        dueDate: doc.dueDate,
        amountDue: amountDueOf(doc),
        invoice: null,
      };
    }
    case 'receipt': {
      const doc = toReceipt(data, findReceipt(data, id));
      if (doc.status === 'voided') return notIssued();
      return {
        number: doc.number,
        date: doc.date,
        customerId: doc.customer.id,
        total: doc.amount,
        until: null,
        dueDate: null,
        amountDue: null,
        invoice: null,
      };
    }
    case 'credit_note': {
      const doc = toCreditNote(data, findCreditNote(data, id));
      if (doc.number === null) return notIssued();
      return {
        number: doc.number,
        date: doc.date,
        customerId: doc.customer.id,
        total: doc.total,
        until: null,
        dueDate: null,
        amountDue: null,
        invoice: doc.invoice.number,
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The customer's words: the API's copy.ts, only the sentences the screens show

const TITLES = {
  en: {
    quotation: 'Quotation',
    invoice: 'Invoice',
    receipt: 'Money receipt',
    credit_note: 'Credit note',
  },
  bn: {
    quotation: 'কোটেশন',
    invoice: 'ইনভয়েস',
    receipt: 'মানি রিসিট',
    credit_note: 'ক্রেডিট নোট',
  },
} satisfies Record<LanguageCode, Record<OutputDocument, string>>;

function money(amount: string, language: LanguageCode): string {
  return formatMoney(amount, language, { decimals: 2 });
}

// A date part, read in local time like the app's date picker: "2026-09-23" is the 23rd everywhere
function day(iso: string, language: LanguageCode): string {
  return formatDate(new Date(`${iso}T00:00:00`), language);
}

function emailSubject(kind: OutputDocument, doc: Issued, company: string, language: LanguageCode) {
  const title = TITLES[language][kind];
  return language === 'bn'
    ? `${company} থেকে ${title} ${doc.number}`
    : `${title} ${doc.number} from ${company}`;
}

function emailMessage(
  kind: OutputDocument,
  doc: Issued,
  customer: string,
  company: string,
  language: LanguageCode,
): string {
  const amount = money(doc.total, language);
  const until = doc.until === null ? '' : day(doc.until, language);
  if (language === 'bn') {
    const lead = {
      quotation: `আমাদের কোটেশন ${doc.number} (${amount}) সংযুক্ত করা হলো।`,
      invoice: `ইনভয়েস ${doc.number} (${amount}) সংযুক্ত করা হলো। পরিশোধের তারিখ ${until}।`,
      receipt: `আপনার পেমেন্টের জন্য ধন্যবাদ। মানি রিসিট ${doc.number} (${amount}) সংযুক্ত করা হলো।`,
      credit_note: `ইনভয়েস ${doc.invoice ?? ''}-এর বিপরীতে ক্রেডিট নোট ${doc.number} (${amount}) সংযুক্ত করা হলো।`,
    } satisfies Record<OutputDocument, string>;
    return `প্রিয় ${customer},\n\n${lead[kind]}\n\nধন্যবাদান্তে,\n${OWNER.fullName}\n${company}`;
  }
  const lead = {
    quotation: `Please find attached our quotation ${doc.number} for ${amount}.`,
    invoice: `Please find attached invoice ${doc.number} for ${amount}, due on ${until}.`,
    receipt: `Thank you for your payment. Please find attached money receipt ${doc.number} for ${amount}.`,
    credit_note: `Please find attached credit note ${doc.number} for ${amount}, against invoice ${doc.invoice ?? ''}.`,
  } satisfies Record<OutputDocument, string>;
  return `Dear ${customer},\n\n${lead[kind]}\n\nRegards,\n${OWNER.fullName}\n${company}`;
}

function shareMessage(
  kind: OutputDocument,
  doc: Issued,
  company: string,
  url: string,
  language: LanguageCode,
): string {
  const title = TITLES[language][kind];
  const amount = money(doc.total, language);
  return language === 'bn'
    ? `${company}: ${title} ${doc.number}, ${amount}।\nPDF দেখুন বা নামান: ${url}\nলিংকটা ${formatNumber(SHARE_LINK_DAYS, 'bn')} দিন কাজ করবে।`
    : `${company}: ${title} ${doc.number} for ${amount}.\nOpen or download the PDF: ${url}\nThe link works for ${String(SHARE_LINK_DAYS)} days.`;
}

// ---------------------------------------------------------------------------------------------
// The PDF

// The mock has no storage: the "PDF" is a line of text in a blob URL, like an export's file
function downloadOf(file: MockDocumentFile): DocumentFile['download'] {
  if (file.status !== 'ready') return null;
  const text = `Omnivo mock PDF: ${file.fileName ?? ''} (${file.language})\n`;
  return {
    url: URL.createObjectURL(new Blob([text], { type: 'text/plain' })),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

// The contract's shape: everything but the mock's own fields. A ready file gets a fresh link on
// every read, like the API's signed link.
export function toDocumentFile(file: MockDocumentFile): DocumentFile {
  return {
    id: file.id,
    language: file.language,
    status: file.status,
    fileName: file.fileName,
    sizeBytes: file.sizeBytes,
    download: downloadOf(file),
    createdAt: file.createdAt,
    finishedAt: file.finishedAt,
  };
}

// POST /documents/:kind/:id/files: the file already made for this look, else a new pending one.
// Two clicks while the first is pending share one file (the API's unique look).
export function requestFile(
  data: WorkspaceData,
  kind: OutputDocument,
  id: string,
  language: LanguageCode,
): MockDocumentFile {
  const doc = issuedOf(data, kind, id);
  const look = JSON.stringify({ doc, language, company: data.settings.companyName });
  const made = data.documentOutput.files.find(
    (file) => file.kind === kind && file.documentId === id && file.look === look,
  );
  if (made) return made;
  const file: MockDocumentFile = {
    id: crypto.randomUUID(),
    kind,
    documentId: id,
    language,
    status: 'pending',
    fileName: null,
    sizeBytes: null,
    download: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    name: `${doc.number}.pdf`,
    look,
    readyAt: Date.now() + FILE_DELAY_MS,
  };
  data.documentOutput.files.push(file);
  return file;
}

// GET /documents/:kind/:id/files/:fileId: a file of another document is not found, like the API
export function findFile(
  data: WorkspaceData,
  kind: OutputDocument,
  id: string,
  fileId: string,
): MockDocumentFile {
  const file = data.documentOutput.files.find(
    (item) => item.id === fileId && item.kind === kind && item.documentId === id,
  );
  if (!file) throw new MockProblem(404, 'not_found');
  return file;
}

// ---------------------------------------------------------------------------------------------
// Email

export function emailDraft(
  data: WorkspaceData,
  kind: OutputDocument,
  id: string,
  language: LanguageCode,
): DocumentEmailDraft {
  const doc = issuedOf(data, kind, id);
  const customer = findCustomer(data.sales, doc.customerId);
  const company = data.settings.companyName;
  return {
    to: customer.email ?? '',
    subject: emailSubject(kind, doc, company, language),
    message: emailMessage(kind, doc, customer.name, company, language),
  };
}

export function toDocumentEmail(email: MockDocumentEmail): DocumentEmail {
  return {
    id: email.id,
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    language: email.language,
    status: email.status,
    sentBy: email.sentBy,
    createdAt: email.createdAt,
    sentAt: email.sentAt,
  };
}

// Queued, not sent: the pretend worker sends it a moment later (settleDocumentOutput)
export function sendEmail(
  data: WorkspaceData,
  kind: OutputDocument,
  id: string,
  input: DocumentEmailInput,
): MockDocumentEmail {
  const doc = issuedOf(data, kind, id);
  const email: MockDocumentEmail = {
    id: crypto.randomUUID(),
    kind,
    documentId: id,
    number: doc.number,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    language: input.language,
    status: 'pending',
    sentBy: { id: OWNER.id, name: OWNER.fullName },
    createdAt: new Date().toISOString(),
    sentAt: null,
    sendsAt: Date.now() + EMAIL_DELAY_MS,
  };
  data.documentOutput.emails.unshift(email);
  return email;
}

// ---------------------------------------------------------------------------------------------
// Share links

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function toDocumentShare(share: MockDocumentShare): DocumentShare {
  return {
    id: share.id,
    language: share.language,
    createdBy: share.createdBy,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
    firstOpenedAt: share.firstOpenedAt,
    lastOpenedAt: share.lastOpenedAt,
  };
}

// The link is in this answer only (decision 13). The mock keeps no token: a link opens in a new
// tab, and a new tab starts its own mock from the seed, which has never heard of it. The public
// page answers the demo links below instead, like the invitation page's demo tokens.
export function createShare(
  data: WorkspaceData,
  kind: OutputDocument,
  id: string,
  language: LanguageCode,
): CreatedShare {
  const doc = issuedOf(data, kind, id);
  const customer = findCustomer(data.sales, doc.customerId);
  const now = Date.now();
  const share: MockDocumentShare = {
    id: crypto.randomUUID(),
    kind,
    documentId: id,
    language,
    createdBy: { id: OWNER.id, name: OWNER.fullName },
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SHARE_LINK_DAYS * 86_400_000).toISOString(),
    revokedAt: null,
    firstOpenedAt: null,
    lastOpenedAt: null,
  };
  data.documentOutput.shares.unshift(share);
  // Like the API, the link starts the PDF, so the customer seldom waits for it
  requestFile(data, kind, id, language);
  const url = `${window.location.origin}/d/${newToken()}`;
  console.info(`[mock] share link: ${url} (open a demo link instead: see DEMO_SHARE_TOKENS)`);
  const message = shareMessage(kind, doc, data.settings.companyName, url, language);
  return {
    share: toDocumentShare(share),
    url,
    message,
    whatsAppUrl: whatsAppUrl(customer.phone, message),
  };
}

// Turning off an off link changes nothing and is not an error; a link of another document is
// not found (the API's revokeShare)
export function revokeShare(
  data: WorkspaceData,
  kind: OutputDocument,
  id: string,
  shareId: string,
): void {
  const share = data.documentOutput.shares.find(
    (item) => item.id === shareId && item.kind === kind && item.documentId === id,
  );
  if (!share) throw new MockProblem(404, 'not_found');
  share.revokedAt ??= new Date().toISOString();
}

// ---------------------------------------------------------------------------------------------
// The seed

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const DAY_MINUTES = 24 * 60;

// The declined H&M quotation went out a month ago: an email that arrived, a link the buyer opened
// until it ended, and a second link turned off the next day. The history cards and their pills
// have something to show from the first page load. Nothing is seeded for the pharmacy.
export function seedDocumentOutput(data: WorkspaceData, garments: boolean): void {
  if (!garments) return;
  const hm = data.sales.customers.find((item) => item.name === 'H&M Hennes & Mauritz GBC AB');
  const quotation = data.salesDocuments.quotations.find(
    (item) => item.customer.id === hm?.id && item.status === 'declined',
  );
  if (!hm || !quotation) return;
  const sentBy = { id: OWNER.id, name: OWNER.fullName };
  const ofQuotation = { kind: 'quotation', documentId: quotation.id } as const;
  // A minute past 30 days: the link has just ended, on the quotation's own date
  const month = 30 * DAY_MINUTES + 1;
  data.documentOutput.emails = [
    {
      ...ofQuotation,
      id: crypto.randomUUID(),
      number: quotation.number,
      to: [hm.email ?? 'sourcing.dhaka@hm.com'],
      cc: ['merchandising@rahmangarments.com'],
      subject: `Quotation ${quotation.number} from ${data.settings.companyName}`,
      language: 'en',
      status: 'sent',
      sentBy,
      createdAt: ago(month - 5),
      sentAt: ago(month - 6),
      sendsAt: 0,
    },
  ];
  data.documentOutput.shares = [
    {
      ...ofQuotation,
      id: crypto.randomUUID(),
      language: 'en',
      createdBy: sentBy,
      createdAt: ago(29 * DAY_MINUTES),
      expiresAt: ago(29 * DAY_MINUTES - SHARE_LINK_DAYS * DAY_MINUTES),
      revokedAt: ago(28 * DAY_MINUTES),
      firstOpenedAt: null,
      lastOpenedAt: null,
    },
    {
      ...ofQuotation,
      id: crypto.randomUUID(),
      language: 'en',
      createdBy: sentBy,
      createdAt: ago(month),
      expiresAt: ago(month - SHARE_LINK_DAYS * DAY_MINUTES),
      revokedAt: null,
      firstOpenedAt: ago(month - 90),
      lastOpenedAt: ago(26 * DAY_MINUTES),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// The pretend worker

// Called on every read, like settleExports: what the worker would have done by now. An address
// with "bounce" in it never arrives (as for invitations): the email fails and the bell says so.
export function settleDocumentOutput(data: WorkspaceData): void {
  const now = Date.now();
  for (const file of data.documentOutput.files) {
    if (file.status !== 'pending' || now < file.readyAt) continue;
    Object.assign(file, {
      status: 'ready',
      fileName: file.name,
      sizeBytes: 48_213,
      finishedAt: new Date(now).toISOString(),
    });
  }
  for (const email of data.documentOutput.emails) {
    if (email.status !== 'pending' || now < email.sendsAt) continue;
    if ([...email.to, ...email.cc].some((address) => address.includes('bounce'))) {
      email.status = 'failed';
      data.notifications.unshift({
        id: crypto.randomUUID(),
        type: 'document.email_failed',
        params: { document: email.kind, id: email.documentId, number: email.number },
        readAt: null,
        createdAt: new Date(now).toISOString(),
      });
    } else {
      Object.assign(email, { status: 'sent', sentAt: new Date(now).toISOString() });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The public page's demo links

// A page opened at /d/<token> starts a fresh mock (a new tab, or Playwright's goto), so these
// links always answer. 22 characters, the shape of a real token.
export const DEMO_SHARE_TOKENS = {
  // An invoice in English, its PDF already made
  invoice: 'demo-invoice-link-0042',
  // A quotation in Bangla, its PDF still being made the first time the page asks
  bangla: 'demo-bangla-quote-0003',
  // A receipt whose PDF the worker could not make
  failed: 'demo-failed-receipt-07',
} as const;
// Any other token is not found: an unknown, an ended and a turned-off link get the same answer
// (decision 14)

// When each demo link was first opened in this tab: the pending PDF is ready a moment later
const demoOpened = new Map<string, number>();

// A pending one is ready 1.5 seconds after the first answer: the page's first poll (2 s) finds it
function demoFile(
  token: string,
  number: string,
  language: LanguageCode,
  status: DocumentFile['status'],
): DocumentFile {
  const opened = demoOpened.get(token) ?? Date.now();
  demoOpened.set(token, opened);
  const file: MockDocumentFile = {
    id: crypto.randomUUID(),
    kind: 'invoice',
    documentId: crypto.randomUUID(),
    name: `${number}.pdf`,
    language,
    status: status === 'pending' && Date.now() >= opened + 1_500 ? 'ready' : status,
    fileName: null,
    sizeBytes: null,
    download: null,
    createdAt: new Date(opened).toISOString(),
    finishedAt: null,
    look: token,
    readyAt: opened,
  };
  if (file.status === 'ready') {
    Object.assign(file, { fileName: file.name, sizeBytes: 48_213, finishedAt: file.createdAt });
  }
  return toDocumentFile(file);
}

function daysAfter(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// GET /public/documents/:token. The company is the workspace's; the rest is a fixed example.
export function publicDocument(data: WorkspaceData, token: string): PublicDocument {
  const today = todayIn(data.settings.timezone);
  const company = data.settings.companyName;
  switch (token) {
    case DEMO_SHARE_TOKENS.invoice:
      return {
        company,
        logoUrl: data.settings.logo?.url ?? null,
        kind: 'invoice',
        number: 'INV-2026-27-0042',
        date: today,
        customer: 'Aarong',
        total: '115000.0000',
        currency: data.settings.baseCurrency,
        dueDate: daysAfter(today, 30),
        amountDue: '40000.0000',
        language: 'en',
        file: demoFile(token, 'INV-2026-27-0042', 'en', 'ready'),
      };
    case DEMO_SHARE_TOKENS.bangla:
      return {
        company,
        logoUrl: null,
        kind: 'quotation',
        number: 'QT-2026-27-0003',
        date: today,
        customer: 'Aarong',
        total: '72427.5000',
        currency: data.settings.baseCurrency,
        dueDate: null,
        amountDue: null,
        language: 'bn',
        file: demoFile(token, 'QT-2026-27-0003', 'bn', 'pending'),
      };
    case DEMO_SHARE_TOKENS.failed:
      return {
        company,
        logoUrl: null,
        kind: 'receipt',
        number: 'MR-2026-27-0007',
        date: today,
        customer: 'Bengal Buying House Ltd.',
        total: '25000.0000',
        currency: data.settings.baseCurrency,
        dueDate: null,
        amountDue: null,
        language: 'en',
        file: demoFile(token, 'MR-2026-27-0007', 'en', 'failed'),
      };
    default:
      throw new MockProblem(404, 'share_link_not_found');
  }
}
