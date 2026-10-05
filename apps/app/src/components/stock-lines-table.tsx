import { Alert02Icon } from '@hugeicons/core-free-icons';
import {
  compareQuantity,
  type StockLine,
  subtractQuantity,
  type TransferLine,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card, Pill } from '@omnivo/ui';

import { useIsoDate, useQuantity, VariantCell } from './stock-parts';

// The lines of a posted adjustment or a sent transfer: a real <table> in a card, scrolling inside
// its own box on a phone. What was typed (3 case), the base quantity it was (72 pcs), the batch
// with its expiry or the serial numbers — and for a received transfer, what arrived.
export function StockLinesTable({
  lines,
  received = false,
}: {
  lines: readonly (StockLine | TransferLine)[];
  received?: boolean;
}) {
  const { t } = useLocale();
  const quantity = useQuantity();
  const isoDate = useIsoDate();
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-body-sm">
        <caption className="sr-only">{t('stockLines.items')}</caption>
        <thead>
          <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
            <th scope="col" className="px-5 py-2.5">
              {t('stock.columns.product')}
            </th>
            <th scope="col" className="px-5 py-2.5 text-right">
              {t('stockLines.quantity')}
            </th>
            <th scope="col" className="px-5 py-2.5">
              {t('stock.history.detail')}
            </th>
            {received && (
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('transfers.receivedQuantity')}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const arrived = 'receivedQuantity' in line ? line.receivedQuantity : null;
            const short =
              arrived !== null && compareQuantity(arrived, line.baseQuantity) < 0
                ? subtractQuantity(line.baseQuantity, arrived)
                : null;
            return (
              <tr key={line.id} className="border-t border-line align-top">
                <td className="px-5 py-3">
                  <VariantCell item={line} />
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
                <td className="px-5 py-3">
                  {line.lotNumber !== null && (
                    <span className="block">
                      <span className="font-mono text-caption">{line.lotNumber}</span>
                      {line.expiresOn !== null && (
                        <span className="text-caption text-ink-3">
                          {' '}
                          · {t('stock.expires')} {isoDate(line.expiresOn)}
                        </span>
                      )}
                    </span>
                  )}
                  {line.serialNumbers.length > 0 && (
                    <span className="block font-mono text-caption break-all text-ink-2">
                      {line.serialNumbers.join(', ')}
                    </span>
                  )}
                  {line.lotNumber === null && line.serialNumbers.length === 0 && (
                    <span className="text-ink-3">—</span>
                  )}
                </td>
                {received && (
                  <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                    {arrived === null ? '—' : quantity(arrived, line.baseUnitId)}
                    {short !== null && (
                      <span className="mt-1 block">
                        <Pill tone="crit" icon={Alert02Icon}>
                          {t('transfers.shortBy', { quantity: quantity(short, line.baseUnitId) })}
                        </Pill>
                      </span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
