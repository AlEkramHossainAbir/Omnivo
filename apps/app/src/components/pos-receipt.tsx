import {
  isZeroMoney,
  type PosPaperWidth,
  type PosShiftReport,
  POS_TENDERS,
  shiftNetOf,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { cn, parseIsoDate } from '@omnivo/ui';
import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import type { ReceiptCompany, ReceiptData } from '../lib/pos';
import type { ReturnSlipData } from '../lib/pos-returns';
import { differenceKind } from '../lib/pos-shift';

// Step 20a (decision 6): the thermal receipt. Printed by the browser (window.print()), like every
// document since step 15c, so it works offline, in every browser and with any printer driver; no
// ESC/POS. Like PrintSheet it goes straight into <body> with data-print-sheet, so the print rule
// in styles.css prints it and nothing else; it is hidden on the screen.
//
// The paper: the roll's width is the printer driver's paper size (set once on the counter's PC),
// so the page rule says `size: auto` and no margin, and the receipt draws itself at the roll's
// printable width: 72 mm on an 80 mm roll, 48 mm on a 58 mm one. A fixed `size: 80mm 200mm` would
// cut every receipt at 20 cm; `80mm auto` is not valid CSS, and the browser would ignore it and
// print on the A4 of the global rule. This <style> comes after styles.css in the page, so its
// @page wins while the receipt is there, and goes with it.
const PRINTABLE_WIDTH = { '58': 'w-[48mm]', '80': 'w-[72mm]' } as const;

// Step 20c: the paper every slip shares (the receipt, the return slip, the X and Z reports), so
// they print the same way. printKey: printOnMount prints once per key; the ref keeps the key it
// printed, so React's second run of the effect in development does not print twice. Each slip is
// lazy, so printing from the screen's own effect could run before the sheet exists and print the
// screen. onPrinted: after the print dialog closed (window.print() waits for it), for a report that
// leaves the page once printed.
function ThermalSheet({
  paperWidth,
  printKey,
  printOnMount,
  onPrinted,
  children,
}: {
  paperWidth: PosPaperWidth;
  printKey: string;
  printOnMount: boolean;
  onPrinted?: (() => void) | undefined;
  children: ReactNode;
}) {
  const printed = useRef<string | null>(null);
  useEffect(() => {
    if (!printOnMount || printed.current === printKey) return;
    printed.current = printKey;
    window.print();
    onPrinted?.();
  }, [printOnMount, printKey, onPrinted]);
  return createPortal(
    <article
      data-print-sheet=""
      className={cn(
        'hidden bg-surface text-caption text-ink print:block',
        PRINTABLE_WIDTH[paperWidth],
      )}
    >
      <style>{'@page { size: auto; margin: 0; }'}</style>
      {children}
    </article>,
    document.body,
  );
}

function CompanyHeader({ company }: { company: ReceiptCompany }) {
  return (
    <header className="grid justify-items-center gap-0.5 border-b border-dashed border-ink pb-2 text-center">
      <p className="text-body-sm font-semibold">{company.name}</p>
      {company.lines.map((line, index) => (
        <p key={`${String(index)}-${line}`}>{line}</p>
      ))}
    </header>
  );
}

// printOnMount: the screen prints the receipt of the sale just paid as soon as it is drawn. The
// sale's page draws it hidden and prints it from its button. Step 20c: an exchange's sale prints
// its return's slip first, on the same paper (returnSlip): one print, two slips.
export function PosReceipt({
  receipt,
  company,
  printOnMount = false,
  returnSlip,
}: {
  receipt: ReceiptData;
  company: ReceiptCompany;
  printOnMount?: boolean;
  returnSlip?: ReturnSlipData | undefined;
}) {
  const { t, format } = useLocale();
  // Always to the paisa: a receipt is a document, and its lines must add up to its total
  const money = (value: string) => format.money(value, { decimals: 2 });
  return (
    <ThermalSheet
      paperWidth={receipt.paperWidth}
      printKey={receipt.number}
      printOnMount={printOnMount}
    >
      {returnSlip && (
        // break-after-page: the driver cuts the paper between the two slips
        <div className="break-after-page pb-4">
          <ReturnSlipBody slip={returnSlip} company={company} />
        </div>
      )}
      <CompanyHeader company={company} />
      <div className="grid gap-0.5 border-b border-dashed border-ink py-2">
        <p className="text-center text-body-sm font-semibold">{t('pos.receipt.title')}</p>
        <p className="font-mono">{t('pos.receipt.number', { number: receipt.number })}</p>
        <p>{format.dateTime(new Date(receipt.soldAt), company.timeZone)}</p>
        <p>
          {t('pos.receipt.register', { code: receipt.registerCode })} ·{' '}
          {t('pos.receipt.cashier', { name: receipt.cashier })}
        </p>
        {receipt.customerName && <p>{t('pos.receipt.customer', { name: receipt.customerName })}</p>}
      </div>
      <table className="w-full border-b border-dashed border-ink">
        <thead>
          <tr className="text-left">
            <th className="py-1 font-medium">{t('pos.receipt.item')}</th>
            <th className="py-1 text-right font-medium">{t('pos.receipt.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {receipt.lines.map((line) => (
            // break-inside-avoid: a line never splits where a driver cuts a long receipt
            <tr key={line.key} className="break-inside-avoid align-top">
              <td className="py-0.5 pr-2">
                <p>{line.name}</p>
                <p className="text-ink-2 tabular-nums">
                  {format.number(line.quantity, line.decimals)} {line.unitCode} ×{' '}
                  {money(line.unitPrice)}
                </p>
                {!isZeroMoney(line.discount) && (
                  <p className="text-ink-2 tabular-nums">
                    {t('pos.receipt.discount')} −{money(line.discount)}
                  </p>
                )}
              </td>
              {/* The line after its own discount, in the price as typed. The bill's discount is
                  one row under the lines, so: lines − bill discount = the total when prices
                  include VAT, = the amount before VAT when they do not */}
              <td className="py-0.5 text-right tabular-nums">{money(line.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="grid gap-0.5 border-b border-dashed border-ink py-2">
        {!isZeroMoney(receipt.billDiscount) && (
          <Line label={t('pos.receipt.billDiscount')}>−{money(receipt.billDiscount)}</Line>
        )}
        <Line label={t('pos.receipt.net')}>{money(receipt.net)}</Line>
        <Line label={t('pos.receipt.vat')}>{money(receipt.vat)}</Line>
        <Line label={t('pos.receipt.total')} strong>
          {money(receipt.total)}
        </Line>
        {receipt.pricesIncludeVat && <p className="text-ink-2">{t('pos.receipt.pricesWithVat')}</p>}
      </dl>
      <dl className="grid gap-0.5 border-b border-dashed border-ink py-2">
        {receipt.payments.map((payment, index) => (
          <Line
            key={`${String(index)}-${payment.method}`}
            label={[t(`pos.methods.${payment.method}`), payment.reference]
              .filter((part) => part !== null)
              .join(' · ')}
          >
            {money(payment.amount)}
          </Line>
        ))}
        <Line label={t('pos.receipt.paid')}>{money(receipt.paid)}</Line>
        <Line label={t('pos.receipt.change')}>{money(receipt.change)}</Line>
      </dl>
      <footer className="grid justify-items-center gap-1 pt-2 text-center">
        {receipt.receiptFooter && <p className="whitespace-pre-line">{receipt.receiptFooter}</p>}
        <p>{t('pos.receipt.thanks')}</p>
      </footer>
    </ThermalSheet>
  );
}

// Step 20c: the return slip (decision 4's look, the receipt's paper). Printed by itself after the
// return; an exchange's prints with its sale's receipt (above).
export function PosReturnSlip({
  slip,
  company,
  printOnMount = false,
}: {
  slip: ReturnSlipData;
  company: ReceiptCompany;
  printOnMount?: boolean;
}) {
  return (
    <ThermalSheet paperWidth={slip.paperWidth} printKey={slip.number} printOnMount={printOnMount}>
      <ReturnSlipBody slip={slip} company={company} />
    </ThermalSheet>
  );
}

function ReturnSlipBody({ slip, company }: { slip: ReturnSlipData; company: ReceiptCompany }) {
  const { t, format } = useLocale();
  const money = (value: string) => format.money(value, { decimals: 2 });
  // The sale's day, read with local date parts (CLAUDE.md → Dates)
  const soldOn = parseIsoDate(slip.sale.date);
  return (
    <>
      <CompanyHeader company={company} />
      <div className="grid gap-0.5 border-b border-dashed border-ink py-2">
        <p className="text-center text-body-sm font-semibold">{t('pos.return.receipt.title')}</p>
        <p className="font-mono">{t('pos.receipt.number', { number: slip.number })}</p>
        <p className="font-mono">{t('pos.return.receipt.ofSale', { number: slip.sale.number })}</p>
        {soldOn && <p>{t('pos.return.receipt.soldOn', { date: format.date(soldOn) })}</p>}
        <p>{format.dateTime(new Date(slip.returnedAt), company.timeZone)}</p>
        <p>
          {t('pos.receipt.register', { code: slip.registerCode })} ·{' '}
          {t('pos.receipt.cashier', { name: slip.cashier })}
        </p>
        {slip.customerName && <p>{t('pos.receipt.customer', { name: slip.customerName })}</p>}
      </div>
      <table className="w-full border-b border-dashed border-ink">
        <thead>
          <tr className="text-left">
            <th className="py-1 font-medium">{t('pos.receipt.item')}</th>
            <th className="py-1 text-right font-medium">{t('pos.receipt.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {slip.lines.map((line) => (
            <tr key={line.key} className="break-inside-avoid align-top">
              <td className="py-0.5 pr-2">
                <p>{line.name}</p>
                <p className="text-ink-2 tabular-nums">
                  {format.number(line.quantity, line.decimals)} {line.unitCode} ×{' '}
                  {money(line.unitPrice)}
                </p>
                {line.serialNumbers.map((serial) => (
                  <p key={serial} className="font-mono text-ink-2">
                    {serial}
                  </p>
                ))}
              </td>
              {/* What the line pays back, with VAT: the lines add up to the total */}
              <td className="py-0.5 text-right tabular-nums">{money(line.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="grid gap-0.5 border-b border-dashed border-ink py-2">
        <Line label={t('pos.receipt.net')}>{money(slip.net)}</Line>
        <Line label={t('pos.receipt.vat')}>{money(slip.vat)}</Line>
        <Line label={t('pos.receipt.total')} strong>
          {money(slip.total)}
        </Line>
      </dl>
      <dl className="grid gap-0.5 border-b border-dashed border-ink py-2">
        <p className="font-medium">{t('pos.return.receipt.given')}</p>
        {slip.refunds.map((refund, index) => (
          <Line
            key={`${String(index)}-${refund.method}`}
            label={[t(`pos.methods.${refund.method}`), refund.reference]
              .filter((part) => part !== null)
              .join(' · ')}
          >
            {money(refund.amount)}
          </Line>
        ))}
        {slip.usedOn && (
          <p className="font-mono">{t('pos.return.receipt.usedOn', { number: slip.usedOn })}</p>
        )}
      </dl>
      <footer className="grid justify-items-center gap-1 pt-2 text-center">
        {slip.note && <p>{slip.note}</p>}
        {slip.receiptFooter && <p className="whitespace-pre-line">{slip.receiptFooter}</p>}
        <p>{t('pos.receipt.thanks')}</p>
      </footer>
    </>
  );
}

// Step 20c (decision 4): the shift's X report (the shift still open, blind: decision 9) or Z report
// (closed, with the drawer). The same sums as the shift's page; every tender the shift used, in
// the order the menus list them.
export function PosShiftReportSheet({
  report,
  paperWidth,
  company,
  onPrinted,
}: {
  report: PosShiftReport;
  paperWidth: PosPaperWidth;
  company: ReceiptCompany;
  onPrinted: () => void;
}) {
  const { t, format } = useLocale();
  const money = (value: string) => format.money(value, { decimals: 2 });
  const time = (value: string) => format.dateTime(new Date(value), company.timeZone);
  const tenders = (amounts: PosShiftReport['taken']) =>
    amounts.length === 0 ? (
      <Line label={t('pos.report.nothing')}>{money('0')}</Line>
    ) : (
      POS_TENDERS.flatMap((method) => {
        const found = amounts.find((amount) => amount.method === method);
        return found
          ? [
              <Line key={method} label={t(`pos.methods.${method}`)}>
                {money(found.amount)}
              </Line>,
            ]
          : [];
      })
    );
  const { drawer } = report;
  return (
    <ThermalSheet
      paperWidth={paperWidth}
      printKey={`${report.kind}-${report.printedAt}`}
      printOnMount
      onPrinted={onPrinted}
    >
      <CompanyHeader company={company} />
      <div className="grid gap-0.5 border-b border-dashed border-ink py-2">
        <p className="text-center text-body-sm font-semibold">
          {t(`pos.report.titles.${report.kind}`)}
        </p>
        <p className="text-center">{t(`pos.report.states.${report.kind}`)}</p>
        <p className="font-mono">{t('pos.report.shift', { number: report.shiftNumber })}</p>
        <p>
          {report.register.code} · {report.register.name}
        </p>
        <p>{t('pos.receipt.cashier', { name: report.cashierName })}</p>
        <p>{t('pos.report.opened', { time: time(report.openedAt) })}</p>
        {report.closedAt && <p>{t('pos.report.closed', { time: time(report.closedAt) })}</p>}
        <p>{t('pos.report.printed', { time: time(report.printedAt) })}</p>
      </div>
      <dl className="grid gap-0.5 border-b border-dashed border-ink py-2">
        <Line
          label={`${t('pos.report.sold')} · ${t('pos.report.sales', {
            count: report.saleCount,
            formatted: format.number(report.saleCount),
          })}`}
        >
          {money(report.salesTotal)}
        </Line>
        <Line
          label={`${t('pos.report.givenBack')} · ${t('pos.report.returns', {
            count: report.returnCount,
            formatted: format.number(report.returnCount),
          })}`}
        >
          {money(report.returnsTotal)}
        </Line>
        <Line label={t('pos.report.net')} strong>
          {money(shiftNetOf(report))}
        </Line>
        <Line label={t('pos.report.discount')}>{money(report.salesDiscount)}</Line>
        <Line label={t('pos.report.salesVat')}>{money(report.salesVat)}</Line>
        <Line label={t('pos.report.returnsVat')}>{money(report.returnsVat)}</Line>
      </dl>
      <dl className="grid gap-0.5 border-b border-dashed border-ink py-2">
        <p className="font-medium">{t('pos.report.taken')}</p>
        {tenders(report.taken)}
        <p className="pt-1 font-medium">{t('pos.report.refunded')}</p>
        {tenders(report.refunded)}
      </dl>
      <dl className="grid gap-0.5 border-b border-dashed border-ink py-2">
        <Line label={t('pos.report.paidIn')}>{money(report.paidIn)}</Line>
        <Line label={t('pos.report.paidOut')}>{money(report.paidOut)}</Line>
      </dl>
      {drawer ? (
        <dl className="grid gap-0.5 py-2">
          <p className="font-medium">{t('pos.report.drawer')}</p>
          <Line label={t('posShifts.cash.opening')}>{money(drawer.opening)}</Line>
          <Line label={t('posShifts.cash.cashTaken')}>{money(drawer.cashTaken)}</Line>
          <Line label={t('posShifts.cash.changeGiven')}>−{money(drawer.changeGiven)}</Line>
          <Line label={t('posShifts.cash.paidIn')}>{money(drawer.paidIn)}</Line>
          <Line label={t('posShifts.cash.paidOut')}>−{money(drawer.paidOut)}</Line>
          <Line label={t('posShifts.cash.cashRefunded')}>−{money(drawer.cashRefunded)}</Line>
          <Line label={t('posShifts.cash.expected')} strong>
            {money(drawer.expected)}
          </Line>
          <Line label={t('pos.report.counted')} strong>
            {money(drawer.counted)}
          </Line>
          <Line label={t('pos.report.difference')} strong>
            {differenceText(t, money, drawer.difference)}
          </Line>
        </dl>
      ) : (
        // An X report says why it has no drawer total (decision 63); a Z without a count, why
        <p className="pt-2 text-center">
          {report.kind === 'x' ? t('pos.report.blind') : t('pos.report.noCount')}
        </p>
      )}
    </ThermalSheet>
  );
}

// "৳50.00 short", "৳20.00 over", "No difference": the close's words (differenceWords in
// pos-shift-parts.tsx), with paisa like every amount on the paper
function differenceText(
  t: ReturnType<typeof useLocale>['t'],
  money: (value: string) => string,
  difference: string,
): string {
  const kind = differenceKind(difference);
  if (kind === 'even') return t('posShifts.even');
  const amount = money(difference.replace(/^-/, ''));
  return kind === 'over' ? t('posShifts.over', { amount }) : t('posShifts.short', { amount });
}

function Line({
  label,
  strong = false,
  children,
}: {
  label: string;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex justify-between gap-2', strong && 'text-body-sm font-semibold')}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  );
}
