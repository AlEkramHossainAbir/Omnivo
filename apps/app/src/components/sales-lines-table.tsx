import {
  defaultLineDescription,
  type DocumentTotals,
  isZeroMoney,
  plainQuantity,
  type SalesLine,
  type SalesOrderLine,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card } from '@omnivo/ui';
import type { ReactNode } from 'react';

import { isServiceLine, leftToDeliver } from '../lib/sales';
import { variantName } from '../lib/stock';
import { useRateText } from '../lib/tax-rates';
import { SalesTotals } from './sales-parts';
import { useQuantity } from './stock-parts';

// The lines of a quotation or an order that is no longer edited here: a real <table> in a card,
// scrolling inside its own box on a phone, with the document's totals under it. An order's lines
// (`delivered`) also say how much went out and how much is left, and (step 15c) how much of it
// posted invoices bill. An invoice's lines use the table as they are. Step 15d: `note` adds the
// document's own words under an item (the return a credit note line gives the money back for).
export function SalesLinesTable<L extends SalesLine | SalesOrderLine>({
  lines,
  totals,
  pricesIncludeVat,
  delivered = false,
  note,
  more,
}: {
  lines: readonly L[];
  totals: DocumentTotals;
  pricesIncludeVat: boolean;
  // An order past its draft: the Delivered and Invoiced columns
  delivered?: boolean;
  note?: (line: L) => ReactNode;
  // Step 17b: more columns after the amount (a purchase order's Received and Rejected): their
  // headers, and a line's cells (one <td> per header)
  more?: { headers: readonly string[]; cells: (line: L) => ReactNode } | undefined;
}) {
  const { t, format } = useLocale();
  const quantity = useQuantity();
  const rateText = useRateText();
  const money = (value: string) => format.money(value, { decimals: 2 });
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-body-sm">
          <caption className="sr-only">{t('salesLines.items')}</caption>
          <thead>
            <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
              <th scope="col" className="px-5 py-2.5">
                {t('salesLines.item')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('salesLines.quantity')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {pricesIncludeVat ? t('salesLines.priceWithVat') : t('salesLines.priceWithoutVat')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('salesLines.discount')}
              </th>
              <th scope="col" className="px-5 py-2.5">
                {t('salesLines.vatRate')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('salesLines.amount')}
              </th>
              {delivered && (
                <th scope="col" className="px-5 py-2.5 text-right">
                  {t('salesOrders.delivered')}
                </th>
              )}
              {delivered && (
                <th scope="col" className="px-5 py-2.5 text-right">
                  {t('salesOrders.invoiced')}
                </th>
              )}
              {more?.headers.map((header) => (
                <th key={header} scope="col" className="px-5 py-2.5 text-right">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} className="border-t border-line align-top">
                <td className="px-5 py-3">
                  <span className="grid max-w-[24rem] min-w-0">
                    <span className="font-medium text-ink">{line.description}</span>
                    {/* The product too, when the line says something else ("220 GSM pique") */}
                    <span className="truncate text-caption text-ink-3">
                      {line.description !== defaultLineDescription(line) &&
                        `${variantName(line)} · `}
                      <span className="font-mono">{line.sku}</span>
                    </span>
                    {note?.(line)}
                  </span>
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {quantity(line.quantity, line.unitId)}
                  {line.unitId !== line.baseUnitId && (
                    <span className="block text-caption text-ink-3">
                      {t('stockLines.equals', {
                        quantity: quantity(line.baseQuantity, line.baseUnitId),
                      })}
                    </span>
                  )}
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {money(line.unitPrice)}
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {isZeroMoney(line.discount)
                    ? '—'
                    : line.discountType === 'percent'
                      ? `${format.number(plainQuantity(line.discount), 2)}%`
                      : money(line.discount)}
                </td>
                <td className="px-5 py-3 whitespace-nowrap">
                  {line.taxRate.name}
                  <span className="block text-caption text-ink-3 tabular-nums">
                    {rateText(line.taxRate.rate)}
                  </span>
                </td>
                <td className="px-5 py-3 text-right font-medium whitespace-nowrap tabular-nums">
                  {money(pricesIncludeVat ? line.total : line.net)}
                </td>
                {delivered && 'deliveredQuantity' in line && (
                  <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                    {isServiceLine(line) ? (
                      <span className="text-caption text-ink-3">
                        {t('salesOrders.serviceLine')}
                      </span>
                    ) : (
                      <>
                        {quantity(line.deliveredQuantity, line.baseUnitId)}
                        <span className="block text-caption text-ink-3">
                          {t('salesOrders.left')}: {quantity(leftToDeliver(line), line.baseUnitId)}
                        </span>
                      </>
                    )}
                  </td>
                )}
                {/* In the base unit, like Delivered: a challan in pieces bills part of a case */}
                {delivered && 'invoicedQuantity' in line && (
                  <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                    {quantity(line.invoicedQuantity, line.baseUnitId)}
                  </td>
                )}
                {more?.cells(line)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SalesTotals totals={totals} pricesIncludeVat={pricesIncludeVat} />
    </Card>
  );
}
