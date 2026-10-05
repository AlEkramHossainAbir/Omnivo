import {
  Alert02Icon,
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
  FileDownloadIcon,
  Pdf01Icon,
  Xls01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  DEFAULT_SETTINGS,
  type ExportFormat,
  isZeroMoney,
  type ReportExportInput,
  type ReportSection,
  routes,
  todayIn,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  cn,
  DatePicker,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  Pill,
  SelectField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';

import { call } from '../lib/api';
import { balanceSide } from '../lib/journal';
import { settingsQuery } from '../lib/queries';
import { type DateRange, PERIOD_PRESETS, type PeriodPreset, presetRange } from '../lib/reports';
import { useSession } from '../lib/session-store';
import { failureOf } from './journal-parts';

// Shared by the three report pages. Here, not in a route file: each route is its own lazy chunk,
// and importing from one would pull that whole page into the others.

// Today and the fiscal year's first month, on the company's clock (not the browser's): the
// presets are worked out from them
export function useReportCalendar(): { today: string; startMonth: number } {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const settings = useQuery(settingsQuery(tenantId)).data;
  return {
    today: todayIn(settings?.timezone ?? DEFAULT_SETTINGS.timezone),
    startMonth: settings?.fiscalYearStartMonth ?? DEFAULT_SETTINGS.fiscalYearStartMonth,
  };
}

// A report's period: a preset ("This fiscal year") until someone picks a date by hand, then
// "Custom dates" with what they picked. The preset's dates follow the settings once they load.
export function usePeriod(initial: Exclude<PeriodPreset, 'custom'> = 'this_year') {
  const { today, startMonth } = useReportCalendar();
  const [preset, setPreset] = useState<PeriodPreset>(initial);
  const [custom, setCustom] = useState<DateRange | null>(null);
  const range =
    preset === 'custom' && custom !== null
      ? custom
      : presetRange(preset === 'custom' ? initial : preset, today, startMonth);
  return {
    preset,
    range,
    // The API refuses a range that ends before it starts; the page says so under "To" instead
    // of asking
    valid: range.from !== '' && range.to !== '' && range.from <= range.to,
    choosePreset: (next: PeriodPreset) => {
      setPreset(next);
      setCustom(next === 'custom' ? range : null);
    },
    chooseRange: (next: DateRange) => {
      setPreset('custom');
      setCustom(next);
    },
  };
}

// "৳18,42,600.50": 2 decimals, so a statement's totals visibly add up (CLAUDE.md → Money)
export function useAmount(): (value: string) => string {
  const { format } = useLocale();
  return (value: string) => format.money(value, { decimals: 2 });
}

// The period: a preset, and the two dates it stands for. Changing a date makes it "Custom dates".
export function PeriodFields({
  preset,
  range,
  onPreset,
  onRange,
}: {
  preset: PeriodPreset;
  range: DateRange;
  onPreset: (preset: PeriodPreset) => void;
  onRange: (range: DateRange) => void;
}) {
  const { t } = useLocale();
  return (
    <>
      <SelectField
        label={t('reports.period')}
        value={preset}
        options={PERIOD_PRESETS.map((value) => ({ value, label: t(`reports.presets.${value}`) }))}
        onChange={(event) => {
          const next = PERIOD_PRESETS.find((value) => value === event.target.value);
          if (next) onPreset(next);
        }}
      />
      <Field id="report-from" label={t('reports.from')}>
        <DatePicker
          id="report-from"
          value={range.from}
          onChange={(from) => {
            onRange({ ...range, from });
          }}
        />
      </Field>
      <Field
        id="report-to"
        label={t('reports.to')}
        error={range.to !== '' && range.from > range.to ? 'report_range_invalid' : undefined}
      >
        <DatePicker
          id="report-to"
          value={range.to}
          onChange={(to) => {
            onRange({ ...range, to });
          }}
        />
      </Field>
    </>
  );
}

// Export → Excel or PDF. The click only asks; the worker writes the file and the bell says when
// it is ready, so a large report never holds the page.
export function ExportMenu({ request }: { request: (format: ExportFormat) => ReportExportInput }) {
  const { t, errorText } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: (format: ExportFormat) =>
      call(routes.reportExports.create, { body: request(format) }),
    onSuccess: async (_saved, format) => {
      toast(t('reports.export.started', { format: t(`reports.formats.${format}`) }));
      await queryClient.invalidateQueries({ queryKey: ['report-exports', tenantId] });
    },
    onError: (error) => {
      toast(errorText(failureOf(error) ?? 'unknown_error'));
    },
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" disabled={create.isPending}>
          <HugeiconsIcon icon={FileDownloadIcon} size={17} strokeWidth={1.5} />
          {t('reports.export.button')}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={16}
            strokeWidth={1.5}
            className="text-ink-3"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          icon={Xls01Icon}
          onSelect={() => {
            create.mutate('xlsx');
          }}
        >
          {t('reports.export.xlsx')}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={Pdf01Icon}
          onSelect={() => {
            create.mutate('pdf');
          }}
        >
          {t('reports.export.pdf')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// "Balanced" when the two sides are equal, "Out by ৳x" when not. The journal's rules make the
// second one impossible; the page still says it, because that is what a trial balance is for.
export function BalancePill({ difference }: { difference: string }) {
  const { t } = useLocale();
  const amount = useAmount();
  return isZeroMoney(difference) ? (
    <Pill tone="good" icon={CheckmarkCircle02Icon}>
      {t('reports.balanced')}
    </Pill>
  ) : (
    <Pill tone="crit" icon={Alert02Icon}>
      {t('reports.outBy', { amount: amount(balanceSide(difference).amount) })}
    </Pill>
  );
}

// ---------------------------------------------------------------------------------------------
// The statement table: a real <table> (screen readers read rows and column headers), inside a card
// that scrolls sideways on its own when the columns do not fit (CLAUDE.md → Page gutters). The
// account column stays put while the amounts scroll.

export interface StatementRow {
  key: string;
  // A ledger account's row links to its ledger; a group's does not
  accountId?: string | undefined;
  code?: string | undefined;
  name: string;
  depth: number;
  style: 'normal' | 'group' | 'heading' | 'total' | 'grand';
  hint?: string | undefined;
  // One cell per amount column: text as shown, or null for an empty cell
  cells: (ReactNode | null)[];
}

// The rows of one report section: the heading, its accounts and groups, and the total
export function sectionRows(
  section: ReportSection,
  labels: { heading: string; total: string },
  amount: (value: string) => string,
  withCompare: boolean,
): StatementRow[] {
  const cells = (value: string, compare: string | null) =>
    withCompare ? [amount(value), amount(compare ?? '0')] : [amount(value)];
  return [
    { key: `${section.type}-heading`, name: labels.heading, depth: 0, style: 'heading', cells: [] },
    ...section.rows.map((row): StatementRow => ({
      key: row.accountId,
      accountId: row.isGroup ? undefined : row.accountId,
      code: row.code,
      name: row.name,
      depth: row.depth + 1,
      style: row.isGroup ? 'group' : 'normal',
      cells: cells(row.amount, row.compareAmount),
    })),
    {
      key: `${section.type}-total`,
      name: labels.total,
      depth: 0,
      style: 'total',
      cells: cells(section.total, section.compareTotal),
    },
  ];
}

export function StatementTable({
  label,
  columns,
  rows,
  ledgerRange,
  empty,
}: {
  label: string;
  // The amount columns' headers; the first column is always "Account"
  columns: string[];
  rows: StatementRow[];
  // The dates the ledger opens with when an account is clicked
  ledgerRange: DateRange;
  empty?: ReactNode;
}) {
  const { t } = useLocale();
  if (empty && !rows.some((row) => row.style === 'normal' || row.style === 'group')) {
    return <>{empty}</>;
  }
  const footer = rows.filter((row) => row.style === 'grand');
  const body = rows.filter((row) => row.style !== 'grand');
  const sticky = 'sticky left-0 z-[1]';
  const row = (item: StatementRow) => {
    const strong = item.style !== 'normal';
    const background =
      item.style === 'total' || item.style === 'grand' ? 'bg-subtle' : 'bg-surface';
    return (
      <tr key={item.key} className={cn('border-t border-line', background)}>
        <th
          scope="row"
          className={cn(
            sticky,
            background,
            // Narrower on a phone, so the first amount still shows next to the name
            'min-w-[10rem] py-2.5 pr-4 text-left text-body-sm font-normal sm:min-w-[14rem]',
            item.style === 'heading' ? 'pt-4 text-caption font-medium text-ink-3' : 'text-ink-2',
            strong && item.style !== 'heading' && 'font-medium text-ink',
          )}
          // 20px, then 16px per level: the tree list's step (CLAUDE.md → Tree list)
          style={{ paddingLeft: 20 + item.depth * 16 }}
        >
          {item.accountId ? (
            <Link
              to="/ledger"
              search={{ account: item.accountId, from: ledgerRange.from, to: ledgerRange.to }}
              aria-label={t('reports.openLedger', { name: item.name })}
              className="underline-offset-3 hover:text-brand hover:underline"
            >
              <span className="font-mono text-ink-3 tabular-nums">{item.code}</span> {item.name}
            </Link>
          ) : (
            <>
              {item.code && <span className="font-mono text-ink-3 tabular-nums">{item.code} </span>}
              {item.name}
            </>
          )}
          {item.hint && (
            <span className="block text-caption font-normal text-ink-3">{item.hint}</span>
          )}
        </th>
        {item.cells.map((cell, index) => (
          <td
            key={index}
            className={cn(
              'min-w-[8.5rem] px-4 py-2.5 text-right text-body-sm whitespace-nowrap tabular-nums sm:px-5',
              strong ? 'font-medium text-ink' : 'text-ink-2',
            )}
          >
            {cell}
          </td>
        ))}
      </tr>
    );
  };
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-sm">
      <table className="w-full border-collapse">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="bg-subtle">
            <th
              scope="col"
              className={cn(
                sticky,
                'bg-subtle py-2.5 pr-4 pl-5 text-left text-caption font-medium text-ink-3',
              )}
            >
              {t('reports.account')}
            </th>
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="px-5 py-2.5 text-right text-caption font-medium whitespace-nowrap text-ink-3"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{body.map(row)}</tbody>
        {footer.length > 0 && <tfoot>{footer.map(row)}</tfoot>}
      </table>
    </div>
  );
}
