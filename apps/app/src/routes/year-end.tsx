import {
  CalendarLock01Icon,
  CheckmarkCircle02Icon,
  SquareUnlock02Icon,
} from '@hugeicons/core-free-icons';
import { type FiscalYear, routes } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  PageHeader,
  Pill,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { useIsoDate } from '../components/journal-parts';
import { useAmount, useReportCalendar } from '../components/report-parts';
import { ApiRequestError, call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { fiscalYearsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<FiscalYear>();

interface Action {
  kind: 'close' | 'reopen';
  year: FiscalYear;
}

// The question before a close or a reopen, and the server's answer if it says no. The errors
// that carry a number (drafts dated in the year) are shown with it.
function ConfirmYear({ action, onDone }: { action: Action; onDone: () => void }) {
  const { t, errorText } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const amount = useAmount();
  const showDate = useIsoDate();
  const { year, kind } = action;
  const run = useMutation({
    mutationFn: () =>
      call(kind === 'close' ? routes.fiscalYears.close : routes.fiscalYears.reopen, {
        body: { end: year.end },
      }),
    onSuccess: async () => {
      // The closing entry, the lock date and every report change: refresh the whole journal
      await queryClient.invalidateQueries({ queryKey: ['journal', tenantId] });
      toast(t(kind === 'close' ? 'yearEnd.closed' : 'yearEnd.reopened', { label: year.label }));
      onDone();
    },
  });
  const failure =
    run.error instanceof ApiRequestError
      ? errorText(run.error.code, run.error.problem.params)
      : run.error
        ? errorText('unknown_error')
        : undefined;
  return (
    <DialogContent
      title={t(kind === 'close' ? 'yearEnd.closeTitle' : 'yearEnd.reopenTitle', {
        label: year.label,
      })}
      description={
        kind === 'close'
          ? t('yearEnd.closeBody', { amount: amount(year.netProfit), date: showDate(year.end) })
          : t('yearEnd.reopenBody', {
              number: year.closingEntry?.number ?? '',
              date: showDate(year.start),
            })
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            disabled={run.isPending}
            onClick={() => {
              run.mutate();
            }}
          >
            {run.isPending
              ? t('common.saving')
              : t(kind === 'close' ? 'yearEnd.confirmClose' : 'yearEnd.confirmReopen')}
          </Button>
        </>
      }
    >
      {failure !== undefined && <FormAlert message={failure} />}
    </DialogContent>
  );
}

export function YearEndPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const can = useCan();
  const canRead = can('accounting.journal.read');
  const canClose = can('accounting.period.close');
  const showDate = useIsoDate();
  const amount = useAmount();
  const { today } = useReportCalendar();
  const { data, isError } = useQuery({ ...fiscalYearsQuery(tenantId), enabled: canRead });
  const [action, setAction] = useState<Action | null>(null);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('label', {
          header: t('yearEnd.columns.year'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-medium text-ink">
                {t('yearEnd.label', { label: row.original.label })}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {t('reports.range', {
                  from: showDate(row.original.start),
                  to: showDate(row.original.end),
                })}
              </span>
            </span>
          ),
        }),
        column.accessor('netProfit', {
          header: t('yearEnd.columns.profit'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => amount(getValue()),
        }),
        column.accessor('status', {
          header: t('yearEnd.columns.status'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => {
            const year = row.original;
            return (
              <span className="grid justify-items-start gap-1">
                {year.status === 'closed' ? (
                  <Pill tone="good" icon={CheckmarkCircle02Icon}>
                    {t('yearEnd.statuses.closed')}
                  </Pill>
                ) : (
                  <Pill tone="neutral" icon={SquareUnlock02Icon}>
                    {t('yearEnd.statuses.open')}
                  </Pill>
                )}
                {year.closingEntry && (
                  <Link
                    to="/journal/$entryId"
                    params={{ entryId: year.closingEntry.id }}
                    className="text-caption font-medium text-brand underline-offset-3 hover:underline"
                  >
                    {t('yearEnd.closingEntry', { number: year.closingEntry.number })}
                  </Link>
                )}
                {year.status === 'open' && year.end >= today && (
                  <span className="text-caption text-ink-3">
                    {t('yearEnd.endsOn', { date: showDate(year.end) })}
                  </span>
                )}
                {year.drafts > 0 && (
                  <span className="text-caption text-warn">
                    {t('yearEnd.drafts', { count: year.drafts })}
                  </span>
                )}
              </span>
            );
          },
        }),
        column.display({
          id: 'action',
          header: () => <span className="sr-only">{t('yearEnd.close')}</span>,
          // On a phone's card: top right, where an action needs no label
          meta: { align: 'end', card: 'trailing' },
          cell: ({ row }) => {
            const year = row.original;
            if (!canClose) return null;
            // Only a year that is over can close; the server says if an earlier one must go first
            if (year.status === 'open' && year.end < today) {
              return (
                <Button
                  size="sm"
                  onClick={() => {
                    setAction({ kind: 'close', year });
                  }}
                >
                  {t('yearEnd.close')}
                </Button>
              );
            }
            if (year.status === 'closed') {
              return (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setAction({ kind: 'reopen', year });
                  }}
                >
                  {t('yearEnd.reopen')}
                </Button>
              );
            }
            return null;
          },
        }),
      ]),
    [t, showDate, amount, today, canClose],
  );

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader
        title={t('yearEnd.title')}
        description={
          data?.lockDate
            ? `${t('yearEnd.description')} · ${t('yearEnd.lockedUntil', { date: showDate(data.lockDate) })}`
            : t('yearEnd.description')
        }
      />
      {!canRead ? (
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.journal.read' })}
        </p>
      ) : (
        <>
          {!canClose && <p className="text-body-sm text-ink-3">{t('yearEnd.readOnly')}</p>}
          {isError && <p className="text-body-sm text-crit">{t('yearEnd.loadFailed')}</p>}
          {data && (
            <DataTable
              label={t('yearEnd.title')}
              data={data.items}
              columns={columns}
              getRowId={(year) => year.end}
              empty={
                <EmptyState
                  icon={CalendarLock01Icon}
                  title={t('yearEnd.title')}
                  description={t('yearEnd.description')}
                />
              }
            />
          )}
        </>
      )}
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
      >
        {action && (
          <ConfirmYear
            // A new dialog per year: no error from the last one carries over
            key={`${action.kind}-${action.year.end}`}
            action={action}
            onDone={() => {
              setAction(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
