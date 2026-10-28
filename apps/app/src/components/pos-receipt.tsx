import { isZeroMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { cn } from '@omnivo/ui';
import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import type { ReceiptCompany, ReceiptData } from '../lib/pos';

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

// printOnMount: the screen prints the receipt of the sale just paid as soon as it is drawn. The
// sale's page draws it hidden and prints it from its button.
export function PosReceipt({
  receipt,
  company,
  printOnMount = false,
}: {
  receipt: ReceiptData;
  company: ReceiptCompany;
  printOnMount?: boolean;
}) {
  const { t, format } = useLocale();
  // Always to the paisa: a receipt is a document, and its lines must add up to its total
  const money = (value: string) => format.money(value, { decimals: 2 });
  // Once it is drawn (decision 6), once per sale: the ref keeps the number it printed, so React's
  // second run of the effect in development does not print twice. The receipt is lazy, so
  // printing from the screen's own effect could run before the sheet exists and print the screen.
  const printed = useRef<string | null>(null);
  useEffect(() => {
    if (!printOnMount || printed.current === receipt.number) return;
    printed.current = receipt.number;
    window.print();
  }, [printOnMount, receipt.number]);
  return createPortal(
    <article
      data-print-sheet=""
      className={cn(
        'hidden bg-surface text-caption text-ink print:block',
        PRINTABLE_WIDTH[receipt.paperWidth],
      )}
    >
      <style>{'@page { size: auto; margin: 0; }'}</style>
      <header className="grid justify-items-center gap-0.5 border-b border-dashed border-ink pb-2 text-center">
        <p className="text-body-sm font-semibold">{company.name}</p>
        {company.lines.map((line, index) => (
          <p key={`${String(index)}-${line}`}>{line}</p>
        ))}
      </header>
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
    </article>,
    document.body,
  );
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
