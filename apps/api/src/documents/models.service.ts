import { Inject, Injectable } from '@nestjs/common';
import {
  amountDueOf,
  amountInWords,
  type CreditNote,
  type Currency,
  defaultLineDescription,
  type DocumentTotals,
  type Invoice,
  isZeroMoney,
  type LanguageCode,
  type OutputDocument,
  type PartyRef,
  type PurchaseOrder,
  type Quotation,
  type Receipt,
  type SalesLine,
  unappliedOf,
} from '@omnivo/contracts';
import { attachments, parties, tenants, tenantSettings, units, warehouses } from '@omnivo/db';
import { and, eq, inArray } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { PurchaseOrdersService } from '../purchase/purchase-orders.service.js';
import { formatAmount, formatIsoDate, formatNumber } from '../reports/export/format.js';
import { CreditNotesService } from '../sales/credit-notes.service.js';
import { InvoicesService } from '../sales/invoices.service.js';
import { QuotationsService } from '../sales/quotations.service.js';
import { ReceiptsService } from '../sales/receipts.service.js';
import { billingAddressOf } from '../sales/sales-lines.js';
import { DOCUMENT_COPY, type DocumentCopy, type DocumentFacts } from './copy.js';
import { type DocumentModel, fingerprintOf } from './model.js';

// pdfkit draws PNG and JPEG. A WebP logo (the settings page takes one) is left off the PDF rather
// than failing it; the public page still shows it, because a browser draws WebP.
const DRAWABLE_LOGOS = new Set(['image/png', 'image/jpeg']);

type Loaded =
  | { kind: 'quotation'; doc: Quotation }
  | { kind: 'invoice'; doc: Invoice }
  | { kind: 'receipt'; doc: Receipt }
  | { kind: 'credit_note'; doc: CreditNote }
  | { kind: 'purchase_order'; doc: PurchaseOrder };

// Who receives it: the customer, or the supplier of a purchase order (step 17b)
function recipientRef(loaded: Loaded): PartyRef {
  return loaded.kind === 'purchase_order' ? loaded.doc.supplier : loaded.doc.customer;
}

// Where a purchase order's goods go: the warehouse's name and address, on one line
interface DeliveryPlace {
  name: string;
  address: string | null;
}

interface Company {
  name: string;
  lines: (copy: DocumentCopy) => string[];
  logo: { key: string; contentType: string } | null;
  // The company's own email: the reply-to of every email (null = replies go nowhere useful)
  email: string | null;
  currency: Currency;
}

interface Unit {
  code: string;
  decimals: number;
}

// One document, ready to be drawn, emailed or shown on the public page
export interface BuiltDocument {
  kind: OutputDocument;
  id: string;
  model: DocumentModel;
  fingerprint: string;
  // What the email and WhatsApp sentences say about it
  facts: DocumentFacts;
  // The customer, or the supplier of a purchase order: where the email and the WhatsApp go
  recipient: { id: string; name: string; email: string | null; phone: string | null };
  company: { name: string; logo: { key: string; contentType: string } | null };
  // The public page's numbers: plain decimal strings and ISO dates, the page formats them
  summary: {
    number: string;
    date: string;
    total: string;
    currency: Currency;
    dueDate: string | null;
    amountDue: string | null;
  };
}

function documentNotIssued(): AppError {
  return new AppError(
    409,
    'document_not_issued',
    'Only a numbered document goes out. Post it first; a voided receipt is not sent.',
  );
}

// The number of a document that may go out (decision 11), or the error. A quotation is numbered
// when it is saved. An invoice and a credit note get theirs when they are posted. A voided receipt
// still has its number, but it is not money received any more. A purchase order is numbered when
// it is submitted (step 17b), but it goes to the supplier only once approved: a pending one may
// still be rejected, and a cancelled one will not be bought. A received or closed order may still
// be sent again (the supplier asks for a copy).
function issuedNumber(loaded: Loaded): string {
  switch (loaded.kind) {
    case 'quotation':
      return loaded.doc.number;
    case 'receipt':
      if (loaded.doc.status !== 'posted') throw documentNotIssued();
      return loaded.doc.number;
    case 'invoice':
    case 'credit_note':
      if (loaded.doc.status === 'draft' || loaded.doc.number === null) throw documentNotIssued();
      return loaded.doc.number;
    case 'purchase_order': {
      const { status, number } = loaded.doc;
      const sent = status === 'approved' || status === 'received' || status === 'closed';
      if (!sent || number === null) throw documentNotIssued();
      return number;
    }
  }
}

// The PDF's model and everything around it, from the same reads the document's own page uses
// (the services' get). Runs in the API only: the worker draws the stored model.
@Injectable()
export class DocumentModels {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly quotations: QuotationsService,
    private readonly invoices: InvoicesService,
    private readonly receipts: ReceiptsService,
    private readonly creditNotes: CreditNotesService,
    private readonly purchaseOrders: PurchaseOrdersService,
  ) {}

  async build(kind: OutputDocument, id: string, language: LanguageCode): Promise<BuiltDocument> {
    const loaded = await this.load(kind, id);
    const number = issuedNumber(loaded);
    const lines = loaded.kind === 'receipt' ? [] : loaded.doc.lines;
    const recipientId = recipientRef(loaded).id;
    const context = await this.withTenant(async (tx) => ({
      company: await companyOf(tx),
      units: await unitsOf(
        tx,
        lines.map((line) => line.unitId),
      ),
      recipient: await recipientOf(tx, recipientId),
      // A purchase order prints the supplier's address and where to deliver; the sales documents
      // keep their own copies of the customer's addresses
      supplierAddress:
        loaded.kind === 'purchase_order' ? await billingAddressOf(tx, recipientId) : null,
      place: loaded.kind === 'purchase_order' ? await placeOf(tx, loaded.doc.warehouseId) : null,
    }));
    const writer = new ModelWriter(language, context.company, context.units);
    const model = writer.model(loaded, number, {
      supplierAddress: context.supplierAddress,
      place: context.place,
    });
    return {
      kind,
      id,
      model,
      fingerprint: fingerprintOf(model),
      facts: writer.facts(loaded, number),
      recipient: context.recipient,
      company: { name: context.company.name, logo: context.company.logo },
      summary: {
        number,
        date: loaded.doc.date,
        total: loaded.kind === 'receipt' ? loaded.doc.amount : loaded.doc.total,
        currency: context.company.currency,
        dueDate: loaded.kind === 'invoice' ? loaded.doc.dueDate : null,
        amountDue: loaded.kind === 'invoice' ? amountDueOf(loaded.doc) : null,
      },
    };
  }

  // Each service throws not_found for a document that does not exist in this workspace
  private async load(kind: OutputDocument, id: string): Promise<Loaded> {
    switch (kind) {
      case 'quotation':
        return { kind, doc: await this.quotations.get(id) };
      case 'invoice':
        return { kind, doc: await this.invoices.get(id) };
      case 'receipt':
        return { kind, doc: await this.receipts.get(id) };
      case 'credit_note':
        return { kind, doc: await this.creditNotes.get(id) };
      case 'purchase_order':
        return { kind, doc: await this.purchaseOrders.get(id) };
    }
  }
}

// The header of every page: the legal name (or the workspace's), the address, the BIN and the
// phone, as the browser print shows them (step 15c)
async function companyOf(tx: Transaction): Promise<Company> {
  const tenantId = getTenantId();
  const [row] = await tx
    .select({
      settings: tenantSettings,
      companyName: tenants.name,
      logoKey: attachments.storageKey,
      logoType: attachments.contentType,
    })
    .from(tenantSettings)
    .innerJoin(tenants, eq(tenants.id, tenantSettings.tenantId))
    .leftJoin(
      attachments,
      and(
        eq(attachments.tenantId, tenantSettings.tenantId),
        eq(attachments.id, tenantSettings.logoAttachmentId),
      ),
    )
    .where(eq(tenantSettings.tenantId, tenantId));
  if (!row) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);
  const { settings } = row;
  return {
    name: settings.legalName ?? row.companyName,
    lines: (copy) => [
      ...(settings.address?.split('\n') ?? []),
      ...(settings.bin === null ? [] : [copy.bin(settings.bin)]),
      ...(settings.phone === null ? [] : [copy.phone(settings.phone)]),
    ],
    logo:
      row.logoKey === null || row.logoType === null
        ? null
        : { key: row.logoKey, contentType: row.logoType },
    email: settings.email,
    currency: settings.baseCurrency,
  };
}

// The code and decimals of the units the lines are counted in ("72 pcs", "2.74 m")
async function unitsOf(tx: Transaction, unitIds: readonly string[]): Promise<Map<string, Unit>> {
  if (unitIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: units.id, code: units.code, decimals: units.decimals })
    .from(units)
    .where(and(eq(units.tenantId, getTenantId()), inArray(units.id, [...new Set(unitIds)])));
  return new Map(rows.map((row) => [row.id, { code: row.code, decimals: row.decimals }]));
}

// Where an email and a WhatsApp message go: the customer's (or the supplier's) own email and phone
async function recipientOf(tx: Transaction, id: string): Promise<BuiltDocument['recipient']> {
  const [row] = await tx
    .select({ id: parties.id, name: parties.name, email: parties.email, phone: parties.phone })
    .from(parties)
    .where(and(eq(parties.tenantId, getTenantId()), eq(parties.id, id)));
  // The document's party FK makes this a broken database, not a 404
  if (!row) throw new Error(`Party ${id} of a document is missing`);
  return row;
}

// The warehouse a purchase order's goods are delivered to (step 17b)
async function placeOf(tx: Transaction, warehouseId: string): Promise<DeliveryPlace> {
  const [row] = await tx
    .select({ name: warehouses.name, address: warehouses.address })
    .from(warehouses)
    .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, warehouseId)));
  if (!row) throw new Error(`Warehouse ${warehouseId} of a purchase order is missing`);
  return row;
}

// Writes the words and numbers of one document in one language
class ModelWriter {
  private readonly copy: DocumentCopy;

  constructor(
    private readonly language: LanguageCode,
    private readonly company: Company,
    private readonly units: Map<string, Unit>,
  ) {
    this.copy = DOCUMENT_COPY[language];
  }

  // ৳ first, 2 decimals, lakh/crore grouping, the language's digits: "৳18,42,600.50"
  private money(value: string): string {
    return `৳${formatAmount(value, this.language)}`;
  }

  private day(iso: string): string {
    return formatIsoDate(iso, this.language);
  }

  private words(amount: string): string {
    return this.copy.inWords(amountInWords(amount, this.language, this.company.currency));
  }

  facts(loaded: Loaded, number: string): DocumentFacts {
    const base = { kind: loaded.kind, title: this.copy.titles[loaded.kind], number };
    switch (loaded.kind) {
      case 'quotation': {
        const { validUntil } = loaded.doc;
        return {
          ...base,
          amount: this.money(loaded.doc.total),
          date: validUntil === null ? null : this.day(validUntil),
          invoice: null,
        };
      }
      case 'invoice':
        return {
          ...base,
          amount: this.money(loaded.doc.total),
          date: this.day(loaded.doc.dueDate),
          invoice: null,
        };
      case 'receipt':
        return { ...base, amount: this.money(loaded.doc.amount), date: null, invoice: null };
      case 'credit_note':
        return {
          ...base,
          amount: this.money(loaded.doc.total),
          date: null,
          invoice: loaded.doc.invoice.number,
        };
      case 'purchase_order': {
        const { expectedDate } = loaded.doc;
        return {
          ...base,
          amount: this.money(loaded.doc.total),
          date: expectedDate === null ? null : this.day(expectedDate),
          invoice: null,
        };
      }
    }
  }

  // extra: what only a purchase order prints, read by build() (null for the sales documents)
  model(
    loaded: Loaded,
    number: string,
    extra: { supplierAddress: string | null; place: DeliveryPlace | null },
  ): DocumentModel {
    const { copy } = this;
    const common = {
      language: this.language,
      title: copy.titles[loaded.kind],
      number,
      fileName: `${number}.pdf`,
      company: {
        name: this.company.name,
        lines: this.company.lines(copy),
        logo:
          this.company.logo !== null && DRAWABLE_LOGOS.has(this.company.logo.contentType)
            ? this.company.logo
            : null,
      },
      page: copy.page('{page}', '{pages}'),
    };
    const numberAndDate = [
      { label: copy.number, value: number },
      { label: copy.date, value: this.day(loaded.doc.date) },
    ];
    const recipient = recipientRef(loaded);
    const party = (label: string, lines: string[] = []) => ({
      label,
      name: recipient.name,
      code: recipient.code,
      lines,
    });
    const note = (text: string | null) =>
      text === null ? null : { label: copy.note, value: text };

    switch (loaded.kind) {
      case 'quotation': {
        const quotation = loaded.doc;
        return {
          ...common,
          meta: [
            ...numberAndDate,
            ...(quotation.validUntil === null
              ? []
              : [{ label: copy.validUntil, value: this.day(quotation.validUntil) }]),
          ],
          party: party(copy.customer),
          facts: [],
          table: this.linesTable(quotation.lines, quotation.pricesIncludeVat),
          totals: this.totals(quotation, quotation.pricesIncludeVat, []),
          // A quotation is an offer, not money owed: no amount in words (decision 7)
          words: null,
          note: note(quotation.note),
          signatures: [copy.signatures.preparedBy, copy.signatures.authorised],
        };
      }
      case 'invoice': {
        const invoice = loaded.doc;
        const orders = invoice.orders.flatMap((order) =>
          order.number === null ? [] : [order.number],
        );
        // What is paid by the day the PDF is drawn, what credit notes took off, and what is still
        // due. Part of the look: a payment makes a new file (decision 18).
        const settled =
          isZeroMoney(invoice.amountPaid) && isZeroMoney(invoice.amountCredited)
            ? []
            : [
                ...(isZeroMoney(invoice.amountPaid)
                  ? []
                  : [{ label: copy.paid, value: this.money(invoice.amountPaid), strong: false }]),
                ...(isZeroMoney(invoice.amountCredited)
                  ? []
                  : [
                      {
                        label: copy.credited,
                        value: this.money(invoice.amountCredited),
                        strong: false,
                      },
                    ]),
                { label: copy.due, value: this.money(amountDueOf(invoice)), strong: true },
              ];
        return {
          ...common,
          meta: [
            ...numberAndDate,
            { label: copy.dueDate, value: this.day(invoice.dueDate) },
            ...(invoice.customerReference === null
              ? []
              : [{ label: copy.customerReference, value: invoice.customerReference }]),
            ...(orders.length === 0 ? [] : [{ label: copy.order, value: orders.join(', ') }]),
          ],
          party: party(copy.billTo, invoice.billingAddress?.split('\n') ?? []),
          facts: [],
          table: this.linesTable(invoice.lines, invoice.pricesIncludeVat),
          totals: this.totals(invoice, invoice.pricesIncludeVat, settled),
          words: this.words(invoice.total),
          note: note(invoice.note),
          signatures: [copy.signatures.customer, copy.signatures.authorised],
        };
      }
      case 'receipt': {
        const receipt = loaded.doc;
        // What refunds paid back is no advance any more (step 15d)
        const advance = unappliedOf(receipt);
        return {
          ...common,
          meta: numberAndDate,
          party: party(copy.receivedFrom),
          facts: [
            { label: copy.amountReceived, value: this.money(receipt.amount) },
            { label: copy.paidBy, value: copy.methods[receipt.method] },
            ...(receipt.reference === null
              ? []
              : [{ label: copy.reference, value: receipt.reference }]),
          ],
          table:
            receipt.allocations.length === 0
              ? null
              : {
                  columns: [
                    { label: copy.allocationColumns.invoice, align: 'left', width: 2 },
                    { label: copy.allocationColumns.date, align: 'left', width: 1.5 },
                    { label: copy.allocationColumns.total, align: 'right', width: 1.5 },
                    { label: copy.allocationColumns.amount, align: 'right', width: 1.5 },
                  ],
                  rows: receipt.allocations.map((allocation) => ({
                    cells: [
                      allocation.invoiceNumber,
                      this.day(allocation.invoiceDate),
                      this.money(allocation.invoiceTotal),
                      this.money(allocation.amount),
                    ],
                    details: [],
                  })),
                },
          totals: isZeroMoney(advance)
            ? null
            : {
                note: null,
                rows: [{ label: copy.advance, value: this.money(advance), strong: false }],
              },
          words: this.words(receipt.amount),
          note: note(receipt.note),
          signatures: [copy.signatures.receivedBy, copy.signatures.authorised],
        };
      }
      case 'credit_note': {
        const creditNote = loaded.doc;
        const reason = creditNote.reason;
        return {
          ...common,
          meta: [
            ...numberAndDate,
            { label: copy.originalInvoice, value: creditNote.invoice.number },
            { label: copy.invoiceDate, value: this.day(creditNote.invoice.date) },
            {
              label: copy.reason,
              // reason is z.string() in the contract (an older client must read a newer reason);
              // a reason this copy does not know is shown as stored rather than failing the PDF
              value: isCreditReason(reason, copy) ? copy.reasons[reason] : reason,
            },
          ],
          party: party(copy.billTo),
          facts: [],
          table: this.linesTable(creditNote.lines, creditNote.pricesIncludeVat),
          totals: this.totals(creditNote, creditNote.pricesIncludeVat, []),
          words: this.words(creditNote.total),
          note: note(creditNote.note),
          signatures: [copy.signatures.preparedBy, copy.signatures.authorised],
        };
      }
      case 'purchase_order': {
        const order = loaded.doc;
        const { place } = extra;
        return {
          ...common,
          meta: [
            ...numberAndDate,
            ...(order.expectedDate === null
              ? []
              : [{ label: copy.deliverBy, value: this.day(order.expectedDate) }]),
            ...(order.supplierReference === null
              ? []
              : [{ label: copy.customerReference, value: order.supplierReference }]),
            { label: copy.paymentTerms, value: copy.termsDays(order.paymentTermsDays) },
          ],
          party: party(copy.supplier, extra.supplierAddress?.split('\n') ?? []),
          // Where the truck goes: the warehouse and its address, on one line
          facts:
            place === null
              ? []
              : [
                  {
                    label: copy.deliverTo,
                    value: [place.name, ...(place.address?.split('\n') ?? [])].join(', '),
                  },
                ],
          table: this.linesTable(order.lines, order.pricesIncludeVat),
          totals: this.totals(order, order.pricesIncludeVat, []),
          // What the company commits to pay, so it is written in words like a bill
          words: this.words(order.total),
          note: note(order.note),
          signatures: [copy.signatures.preparedBy, copy.signatures.authorised],
        };
      }
    }
  }

  // The priced lines, like PricedLines in the browser print: the item with what a pharmacy or an
  // electronics shop asks to see under it, then quantity, price, discount, VAT and amount
  private linesTable(
    lines: readonly (SalesLine & {
      lotNumber?: string | null;
      expiresOn?: string | null;
      serialNumbers?: readonly string[];
      deliveryNumber?: string | null;
      returnNumber?: string | null;
    })[],
    pricesIncludeVat: boolean,
  ): NonNullable<DocumentModel['table']> {
    const { copy, language } = this;
    return {
      columns: [
        { label: copy.columns.number, align: 'left', width: 0.45 },
        { label: copy.columns.item, align: 'left', width: 4.2 },
        { label: copy.columns.quantity, align: 'right', width: 1.3 },
        { label: copy.columns.price, align: 'right', width: 1.4 },
        { label: copy.columns.discount, align: 'right', width: 1.1 },
        { label: copy.columns.vat, align: 'right', width: 1.2 },
        { label: copy.columns.amount, align: 'right', width: 1.5 },
      ],
      rows: lines.map((line, index) => {
        const unit = this.units.get(line.unitId);
        const batch =
          line.lotNumber === null || line.lotNumber === undefined
            ? []
            : [
                [
                  copy.batch(line.lotNumber),
                  ...(line.expiresOn === null || line.expiresOn === undefined
                    ? []
                    : [copy.expires(this.day(line.expiresOn))]),
                ].join(', '),
              ];
        return {
          cells: [
            formatNumber(String(index + 1), 0, language),
            line.description,
            unit === undefined
              ? formatNumber(line.quantity, 0, language)
              : `${formatNumber(line.quantity, unit.decimals, language)} ${unit.code}`,
            this.money(line.unitPrice),
            isZeroMoney(line.discount)
              ? '—'
              : line.discountType === 'percent'
                ? `${formatNumber(line.discount, 2, language)}%`
                : this.money(line.discount),
            line.taxRate.name,
            this.money(pricesIncludeVat ? line.total : line.net),
          ],
          details: [
            line.sku,
            // The variant when the person typed their own description ("220 GSM pique")
            ...(line.description === defaultLineDescription(line)
              ? []
              : [defaultLineDescription(line)]),
            ...batch,
            ...(line.serialNumbers === undefined || line.serialNumbers.length === 0
              ? []
              : [copy.serials(line.serialNumbers.join(', '))]),
            ...(line.deliveryNumber === null || line.deliveryNumber === undefined
              ? []
              : [copy.fromChallan(line.deliveryNumber)]),
            ...(line.returnNumber === null || line.returnNumber === undefined
              ? []
              : [copy.fromReturn(line.returnNumber)]),
          ],
        };
      }),
    };
  }

  // Line discounts (only when there are any), before VAT, VAT, the total, and what follows it
  private totals(
    totals: DocumentTotals,
    pricesIncludeVat: boolean,
    after: { label: string; value: string; strong: boolean }[],
  ): NonNullable<DocumentModel['totals']> {
    const { copy } = this;
    return {
      note: pricesIncludeVat ? copy.pricesWithVat : copy.pricesWithoutVat,
      rows: [
        ...(isZeroMoney(totals.discount)
          ? []
          : [
              {
                label: copy.lineDiscounts,
                value: `−${this.money(totals.discount)}`,
                strong: false,
              },
            ]),
        { label: copy.net, value: this.money(totals.net), strong: false },
        { label: copy.vat, value: this.money(totals.vat), strong: false },
        { label: copy.total, value: this.money(totals.total), strong: true },
        ...after,
      ],
    };
  }
}

function isCreditReason(
  reason: string,
  copy: DocumentCopy,
): reason is keyof DocumentCopy['reasons'] {
  return Object.hasOwn(copy.reasons, reason);
}
