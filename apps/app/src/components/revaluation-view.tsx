import type { StockRevaluation } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card, PageHeader } from '@omnivo/ui';

import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { BackLink, useIsoDate, useQuantity, useValue, VariantCell } from './stock-parts';

// A posted revaluation, read only: it never changes. Each line: the stock it had then, its value
// before and after, and the difference that went to the books.
export function RevaluationView({ revaluation }: { revaluation: StockRevaluation }) {
  const { t } = useLocale();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const value = useValue();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <BackLink to="/stock/revaluations" label={t('revaluations.back')} />
      <PageHeader title={revaluation.number} description={t('revaluations.description')} />
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <Fact label={t('revaluations.date')} value={isoDate(revaluation.date)} />
        {revaluation.note !== null && (
          <Fact label={t('revaluations.note')} value={revaluation.note} />
        )}
        <EntryLinks
          label={t('revaluations.entry')}
          entries={revaluation.entry ? [revaluation.entry] : []}
          none={t('revaluations.noEntry')}
        />
      </Card>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-body-sm">
          <caption className="sr-only">{t('stockLines.items')}</caption>
          <thead>
            <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
              <th scope="col" className="px-5 py-2.5">
                {t('revaluations.lineColumns.product')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('revaluations.lineColumns.quantity')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('revaluations.lineColumns.oldValue')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('revaluations.lineColumns.newCost')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('revaluations.lineColumns.newValue')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('revaluations.lineColumns.difference')}
              </th>
            </tr>
          </thead>
          <tbody>
            {revaluation.lines.map((line) => (
              <tr key={line.id} className="border-t border-line align-top">
                <td className="px-5 py-3">
                  <VariantCell item={line} />
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {quantity(line.quantity, line.baseUnitId)}
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {value(line.oldValue)}
                  <span className="block text-caption text-ink-3">{value(line.oldUnitCost)}</span>
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {value(line.unitCost)}
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {value(line.newValue)}
                </td>
                <td className="px-5 py-3 text-right font-medium whitespace-nowrap tabular-nums">
                  {value(line.difference)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line bg-subtle font-medium">
              <td className="px-5 py-3" colSpan={5}>
                {t('stockLines.total')}
              </td>
              <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                {value(revaluation.difference)}
              </td>
            </tr>
          </tfoot>
        </table>
      </Card>
    </div>
  );
}
