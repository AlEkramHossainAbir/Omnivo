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

import { isServiceLine, leftToDeliver } from '../lib/sales';
import { variantName } from '../lib/stock';
import { useRateText } from '../lib/tax-rates';
import { SalesTotals } from './sales-parts';
import { useQuantity } from './stock-parts';

// The lines of a quotation or an order that is no longer edited here: a real <table> in a card,
// scrolling inside its own box on a phone, with the document's totals under it. An order's lines
// (`delivered`) also say how much went out and how much is left.
export function SalesLinesTable({
  lines,
  totals,
  pricesIncludeVat,
  delivered = false,
}: {
  lines: readonly (SalesLine | SalesOrderLine)[];
  totals: DocumentTotals;
  pricesIncludeVat: boolean;
  delivered?: boolean;
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SalesTotals totals={totals} pricesIncludeVat={pricesIncludeVat} />
    </Card>
  );
}
