import { PrinterIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type Delivery,
  type DocumentTotals,
  defaultLineDescription,
  type Invoice,
  isZeroMoney,
  plainQuantity,
  type Quotation,
  type Receipt,
  type SalesLine,
  type SalesOrder,
  subtractMoney,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, cn, PrintBlock, type PrintMeta, PrintSheet } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { amountDue } from '../lib/invoices';
import { settingsQuery } from '../lib/queries';
import { variantName } from '../lib/stock';
import { useIsoDate, useQuantity, useTenantId } from './stock-parts';

// The printed quotation, order, challan, invoice and money receipt (step 15c): one A4 layout, the
// browser's own Print (or Save as PDF), so it works offline and needs no PDF service. Each page
// renders its sheet next to itself; PrintSheet keeps it hidden on the screen and alone on paper.

// "Print" in a document's header: the browser prints the sheet of the page
export function PrintButton() {
  const { t } = useLocale();
  return (
    <Button
      variant="secondary"
      onClick={() => {
        window.print();
      }}
    >
      <HugeiconsIcon icon={PrinterIcon} size={17} strokeWidth={1.5} />
      {t('print.print')}
    </Button>
  );
}

// The company at the top of every sheet: its legal name (the name on the trade licence) or the
// workspace's, the address one line per line, the BIN (the NBR asks for it on a VAT invoice), the
// phone, and the logo. null until the settings arrive.
function useCompany(): { company: string; lines: string[]; logo: ReactNode } | null {
  const { t } = useLocale();
  const settings = useQuery(settingsQuery(useTenantId())).data;
  if (!settings) return null;
  return {
    company: settings.legalName ?? settings.companyName,
    lines: [
      ...(settings.address?.split('\n') ?? []),
      ...(settings.bin === null ? [] : [t('print.bin', { bin: settings.bin })]),
      ...(settings.phone === null ? [] : [t('print.phone', { phone: settings.phone })]),
    ],
    logo:
      settings.logo === null ? undefined : (
        // Decoration next to the name, which says the same: an empty alt
        <img src={settings.logo.url} alt="" className="h-12 w-auto max-w-32 object-contain" />
      ),
  };
}

// The sheet with the company filled in, and the time it was printed at the foot
function Sheet({
  title,
  meta,
  signatures,
  children,
}: {
  title: string;
  meta: (PrintMeta | null)[];
  signatures: string[];
  children: ReactNode;
}) {
  const { t, format } = useLocale();
  const company = useCompany();
  if (!company) return null;
  return (
    <PrintSheet
      logo={company.logo}
      company={company.company}
      companyLines={company.lines}
      title={title}
      meta={meta.filter((item): item is PrintMeta => item !== null)}
      signatures={signatures}
      footer={t('print.printedAt', { date: format.date(new Date()) })}
    >
      {children}
    </PrintSheet>
  );
}

// The customer: name and code, then an address as it was saved, one part per line
function PartyBlock({
  label,
  name,
  code,
  address,
}: {
  label: string;
  name: string;
  code?: string;
  address?: string | null;
}) {
  return (
    <PrintBlock label={label}>
      <p className="font-medium">{name}</p>
      {code !== undefined && <p className="font-mono text-caption text-ink-2">{code}</p>}
      {address !== null && address !== undefined && (
        <p className="whitespace-pre-line text-ink-2">{address}</p>
      )}
    </PrintBlock>
  );
}

// A sales line on paper, with what a pharmacy or an electronics shop asks to see under it: the
// batch and its expiry, the serial numbers, the challan it left on
interface PricedLine extends SalesLine {
  lotNumber?: string | null;
  expiresOn?: string | null;
  serialNumbers?: string[];
  deliveryNumber?: string | null;
}

const CELL = 'border-b border-line px-2 py-1.5 align-top';
const HEAD = 'border-b border-ink px-2 py-1.5 text-left text-caption font-medium text-ink-2';

function PricedLines({
  lines,
  totals,
  pricesIncludeVat,
  after,
}: {
  lines: readonly PricedLine[];
  totals: DocumentTotals;
  pricesIncludeVat: boolean;
  // Rows under the total: what an invoice was paid and still asks for
  after?: { label: string; value: string }[];
}) {
  const { t, format } = useLocale();
  const quantity = useQuantity();
  const isoDate = useIsoDate();
  const money = (value: string) => format.money(value, { decimals: 2 });
  const sums = [
    ...(isZeroMoney(totals.discount)
      ? []
      : [{ label: t('salesLines.lineDiscounts'), value: `−${money(totals.discount)}` }]),
    { label: t('salesLines.net'), value: money(totals.net) },
    { label: t('salesLines.vat'), value: money(totals.vat) },
  ];
  return (
    <>
      <table className="w-full border-collapse text-caption">
        {/* <thead> repeats at the top of every printed page of a long invoice */}
        <thead>
          <tr>
            <th scope="col" className={HEAD}>
              {t('print.columns.number')}
            </th>
            <th scope="col" className={HEAD}>
              {t('print.columns.item')}
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              {t('print.columns.quantity')}
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              {t('print.columns.price')}
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              {t('print.columns.discount')}
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              {t('print.columns.vat')}
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              {t('print.columns.amount')}
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => {
            const notes = [
              ...(line.description === defaultLineDescription(line) ? [] : [variantName(line)]),
              ...(line.lotNumber === null || line.lotNumber === undefined
                ? []
                : [
                    [
                      t('print.batch', { lot: line.lotNumber }),
                      ...(line.expiresOn === null || line.expiresOn === undefined
                        ? []
                        : [t('print.expires', { date: isoDate(line.expiresOn) })]),
                    ].join(', '),
                  ]),
              ...(line.serialNumbers === undefined || line.serialNumbers.length === 0
                ? []
                : [t('print.serials', { serials: line.serialNumbers.join(', ') })]),
              ...(line.deliveryNumber === null || line.deliveryNumber === undefined
                ? []
                : [t('invoices.fromChallan', { number: line.deliveryNumber })]),
            ];
            return (
              // break-inside-avoid: a line and its notes stay on one page
              <tr key={line.id} className="break-inside-avoid">
                <td className={cn(CELL, 'tabular-nums')}>{index + 1}</td>
                <td className={CELL}>
                  <span className="block text-body-sm text-ink">{line.description}</span>
                  <span className="block font-mono text-ink-3">{line.sku}</span>
                  {notes.map((note) => (
                    <span key={note} className="block text-ink-2">
                      {note}
                    </span>
                  ))}
                </td>
                <td className={cn(CELL, 'text-right whitespace-nowrap tabular-nums')}>
                  {quantity(line.quantity, line.unitId)}
                </td>
                <td className={cn(CELL, 'text-right whitespace-nowrap tabular-nums')}>
                  {money(line.unitPrice)}
                </td>
                <td className={cn(CELL, 'text-right whitespace-nowrap tabular-nums')}>
                  {isZeroMoney(line.discount)
                    ? '—'
                    : line.discountType === 'percent'
                      ? `${format.number(plainQuantity(line.discount), 2)}%`
                      : money(line.discount)}
                </td>
                <td className={cn(CELL, 'text-right whitespace-nowrap tabular-nums')}>
                  {line.taxRate.name}
                </td>
                <td className={cn(CELL, 'text-right whitespace-nowrap tabular-nums')}>
                  {money(pricesIncludeVat ? line.total : line.net)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex break-inside-avoid items-end justify-between gap-6">
        <p className="text-caption text-ink-2">
          {pricesIncludeVat ? t('salesLines.pricesWithVat') : t('salesLines.pricesWithoutVat')}
        </p>
        <dl className="grid min-w-64 grid-cols-[1fr_auto] gap-x-6 gap-y-1 tabular-nums">
          {sums.map((sum) => (
            <div key={sum.label} className="contents">
              <dt className="text-ink-2">{sum.label}</dt>
              <dd className="text-right">{sum.value}</dd>
            </div>
          ))}
          <dt className="border-t border-ink pt-1 font-medium">{t('salesLines.total')}</dt>
          <dd className="border-t border-ink pt-1 text-right font-medium">{money(totals.total)}</dd>
          {after?.map((sum) => (
            <div key={sum.label} className="contents">
              <dt className="text-ink-2">{sum.label}</dt>
              <dd className="text-right">{sum.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}

function Note({ note }: { note: string | null }) {
  const { t } = useLocale();
  if (note === null) return null;
  return (
    <PrintBlock label={t('salesOrders.note')}>
      <p className="whitespace-pre-line">{note}</p>
    </PrintBlock>
  );
}

export function QuotationPrint({ quotation }: { quotation: Quotation }) {
  const { t } = useLocale();
  const isoDate = useIsoDate();
  return (
    <Sheet
      title={t('print.titles.quotation')}
      meta={[
        { label: t('print.number'), value: quotation.number },
        { label: t('print.date'), value: isoDate(quotation.date) },
        quotation.validUntil === null
          ? null
          : { label: t('print.validUntil'), value: isoDate(quotation.validUntil) },
      ]}
      signatures={[t('print.signatures.preparedBy'), t('print.signatures.authorised')]}
    >
      <PartyBlock
        label={t('print.customer')}
        name={quotation.customer.name}
        code={quotation.customer.code}
      />
      <PricedLines
        lines={quotation.lines}
        totals={quotation}
        pricesIncludeVat={quotation.pricesIncludeVat}
      />
      <Note note={quotation.note} />
    </Sheet>
  );
}

export function SalesOrderPrint({ order }: { order: SalesOrder }) {
  const { t } = useLocale();
  const isoDate = useIsoDate();
  return (
    <Sheet
      title={t('print.titles.salesOrder')}
      meta={[
        { label: t('print.number'), value: order.number ?? '' },
        { label: t('print.date'), value: isoDate(order.date) },
        order.deliveryDate === null
          ? null
          : { label: t('print.deliveryDate'), value: isoDate(order.deliveryDate) },
        order.customerReference === null
          ? null
          : { label: t('print.customerReference'), value: order.customerReference },
      ]}
      signatures={[t('print.signatures.customer'), t('print.signatures.authorised')]}
    >
      <div className="grid grid-cols-2 gap-6">
        <PartyBlock
          label={t('print.customer')}
          name={order.customer.name}
          code={order.customer.code}
        />
        {order.shippingAddress !== null && (
          <PartyBlock
            label={t('print.shipTo')}
            name={order.customer.name}
            address={order.shippingAddress}
          />
        )}
      </div>
      <PricedLines lines={order.lines} totals={order} pricesIncludeVat={order.pricesIncludeVat} />
      <Note note={order.note} />
    </Sheet>
  );
}

// The challan goes with the truck: what left and how much, with the batch and serial numbers, and
// no prices (the invoice prices it)
export function DeliveryPrint({ delivery }: { delivery: Delivery }) {
  const { t } = useLocale();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  return (
    <Sheet
      title={t('print.titles.delivery')}
      meta={[
        { label: t('print.number'), value: delivery.number ?? '' },
        { label: t('print.date'), value: isoDate(delivery.date) },
        delivery.order === null
          ? null
          : { label: t('print.order'), value: delivery.order.number ?? '' },
        delivery.vehicle === null ? null : { label: t('print.vehicle'), value: delivery.vehicle },
      ]}
      signatures={[
        t('print.signatures.receivedBy'),
        t('print.signatures.preparedBy'),
        t('print.signatures.authorised'),
      ]}
    >
      <div className="grid grid-cols-2 gap-6">
        <PartyBlock
          label={t('print.customer')}
          name={delivery.customer.name}
          code={delivery.customer.code}
        />
        {delivery.shippingAddress !== null && (
          <PartyBlock
            label={t('print.shipTo')}
            name={delivery.customer.name}
            address={delivery.shippingAddress}
          />
        )}
      </div>
      <table className="w-full border-collapse text-caption">
        <thead>
          <tr>
            <th scope="col" className={HEAD}>
              {t('print.columns.number')}
            </th>
            <th scope="col" className={HEAD}>
              {t('print.columns.item')}
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              {t('print.columns.quantity')}
            </th>
          </tr>
        </thead>
        <tbody>
          {delivery.lines.map((line, index) => (
            <tr key={line.id} className="break-inside-avoid">
              <td className={cn(CELL, 'tabular-nums')}>{index + 1}</td>
              <td className={CELL}>
                <span className="block text-body-sm text-ink">{variantName(line)}</span>
                <span className="block font-mono text-ink-3">{line.sku}</span>
                {line.lotNumber !== null && (
                  <span className="block text-ink-2">
                    {t('print.batch', { lot: line.lotNumber })}
                    {line.expiresOn !== null &&
                      `, ${t('print.expires', { date: isoDate(line.expiresOn) })}`}
                  </span>
                )}
                {line.serialNumbers.length > 0 && (
                  <span className="block break-all text-ink-2">
                    {t('print.serials', { serials: line.serialNumbers.join(', ') })}
                  </span>
                )}
              </td>
              <td className={cn(CELL, 'text-right whitespace-nowrap tabular-nums')}>
                {quantity(line.quantity, line.unitId)}
                {line.unitId !== line.baseUnitId && (
                  <span className="block text-ink-3">
                    {t('stockLines.equals', {
                      quantity: quantity(line.baseQuantity, line.baseUnitId),
                    })}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Note note={delivery.note} />
    </Sheet>
  );
}

export function InvoicePrint({ invoice }: { invoice: Invoice }) {
  const { t, format } = useLocale();
  const isoDate = useIsoDate();
  const money = (value: string) => format.money(value, { decimals: 2 });
  const orders = invoice.orders.flatMap((order) => (order.number === null ? [] : [order.number]));
  return (
    <Sheet
      title={t('print.titles.invoice')}
      meta={[
        { label: t('print.number'), value: invoice.number ?? '' },
        { label: t('print.date'), value: isoDate(invoice.date) },
        { label: t('print.dueDate'), value: isoDate(invoice.dueDate) },
        invoice.customerReference === null
          ? null
          : { label: t('print.customerReference'), value: invoice.customerReference },
        orders.length === 0 ? null : { label: t('print.order'), value: orders.join(', ') },
      ]}
      signatures={[t('print.signatures.customer'), t('print.signatures.authorised')]}
    >
      <PartyBlock
        label={t('print.billTo')}
        name={invoice.customer.name}
        code={invoice.customer.code}
        address={invoice.billingAddress}
      />
      <PricedLines
        lines={invoice.lines}
        totals={invoice}
        pricesIncludeVat={invoice.pricesIncludeVat}
        // What is paid by the day it is printed, and what is still due
        after={
          isZeroMoney(invoice.amountPaid)
            ? []
            : [
                { label: t('invoices.paid'), value: money(invoice.amountPaid) },
                { label: t('invoices.due'), value: money(amountDue(invoice)) },
              ]
        }
      />
      <Note note={invoice.note} />
    </Sheet>
  );
}

// The slip a cashier hands over: who paid, how much, how, and which invoices it paid
export function ReceiptPrint({ receipt }: { receipt: Receipt }) {
  const { t, format } = useLocale();
  const isoDate = useIsoDate();
  const money = (value: string) => format.money(value, { decimals: 2 });
  const advance = subtractMoney(receipt.amount, receipt.applied);
  return (
    <Sheet
      title={t('print.titles.receipt')}
      meta={[
        { label: t('print.number'), value: receipt.number },
        { label: t('print.date'), value: isoDate(receipt.date) },
      ]}
      signatures={[t('print.signatures.receivedBy'), t('print.signatures.authorised')]}
    >
      <div className="grid grid-cols-2 gap-6">
        <PartyBlock
          label={t('print.receivedFrom')}
          name={receipt.customer.name}
          code={receipt.customer.code}
        />
        <PrintBlock label={t('print.amountReceived')}>
          <p className="text-h2 tabular-nums">{money(receipt.amount)}</p>
        </PrintBlock>
        <PrintBlock label={t('print.paidBy')}>
          <p>{t(`receipts.methods.${receipt.method}`)}</p>
        </PrintBlock>
        {receipt.reference !== null && (
          <PrintBlock label={t('print.reference')}>
            <p>{receipt.reference}</p>
          </PrintBlock>
        )}
      </div>
      {receipt.allocations.length > 0 && (
        <PrintBlock label={t('print.appliedTo')}>
          <table className="w-full border-collapse text-caption">
            <thead>
              <tr>
                <th scope="col" className={HEAD}>
                  {t('receipts.allocationColumns.invoice')}
                </th>
                <th scope="col" className={HEAD}>
                  {t('receipts.allocationColumns.date')}
                </th>
                <th scope="col" className={cn(HEAD, 'text-right')}>
                  {t('receipts.allocationColumns.total')}
                </th>
                <th scope="col" className={cn(HEAD, 'text-right')}>
                  {t('receipts.allocationColumns.amount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {receipt.allocations.map((allocation) => (
                <tr key={allocation.invoiceId} className="break-inside-avoid">
                  <td className={cn(CELL, 'font-mono tabular-nums')}>{allocation.invoiceNumber}</td>
                  <td className={cn(CELL, 'tabular-nums')}>{isoDate(allocation.invoiceDate)}</td>
                  <td className={cn(CELL, 'text-right tabular-nums')}>
                    {money(allocation.invoiceTotal)}
                  </td>
                  <td className={cn(CELL, 'text-right tabular-nums')}>
                    {money(allocation.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </PrintBlock>
      )}
      {!isZeroMoney(advance) && (
        <p className="tabular-nums">
          {t('print.advance')}: {money(advance)}
        </p>
      )}
      <Note note={receipt.note} />
    </Sheet>
  );
}
