import {
  Alert02Icon,
  CalendarClockIcon,
  ChartIncreaseIcon,
  ChartLineData01Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PackageMovingIcon,
  PauseCircleIcon,
  PauseIcon,
  PencilEdit02Icon,
  PieChartIcon,
  PlayIcon,
  ShoppingBag01Icon,
  TableIcon,
  TaxesIcon,
  Time04Icon,
  TimeQuarterPassIcon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  isExportFormat,
  isReportKind,
  MAX_REPORT_SCHEDULES,
  type ReportKind,
  type ReportSchedule,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  PageHeader,
  Pill,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useMemo, useState } from 'react';

import { NameTile } from '../components/trade-report-parts';
import { call } from '../lib/api';
import { failureOf } from '../components/journal-parts';
import { useCan } from '../lib/permissions';
import { reportSchedulesQuery, useScheduleWords } from '../lib/report-schedules';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 21c: the workspace's scheduled report emails. No "New" button (decision 57): a schedule is
// made from a report's Export menu, where its filters are. Not sortable: at most 20, newest first
// as the API sends them. No row click either; a row's actions are its menu.

const ReportScheduleDialog = lazy(async () => ({
  default: (await import('../components/report-schedule-dialog')).ReportScheduleDialog,
}));

// The report's tile: the same icon as its link in the sidebar
const REPORT_ICONS = {
  trial_balance: TableIcon,
  profit_and_loss: ChartIncreaseIcon,
  balance_sheet: PieChartIcon,
  sales_report: ChartLineData01Icon,
  purchase_report: ShoppingBag01Icon,
  ar_aging: TimeQuarterPassIcon,
  ap_aging: Time04Icon,
  vat_report: TaxesIcon,
  stock_movement: PackageMovingIcon,
} as const satisfies Record<ReportKind, IconSvgElement>;

const column = dataTableColumns<ReportSchedule>();

// What a row's menu asked for; the page keeps it and opens that dialog
interface Acting {
  kind: 'edit' | 'delete';
  schedule: ReportSchedule;
}

function StatusCell({ schedule }: { schedule: ReportSchedule }) {
  const { t } = useLocale();
  if (schedule.status === 'active') {
    return (
      <Pill tone="good" icon={CheckmarkCircle02Icon}>
        {t('reportSchedules.statuses.active')}
      </Pill>
    );
  }
  // Paused is neutral: someone chose it, or nobody may read the report (the line under Sent to
  // already says that in warn). The reason says what to do.
  return (
    <span className="grid justify-items-start gap-1">
      <Pill tone="neutral" icon={PauseCircleIcon}>
        {t('reportSchedules.statuses.paused')}
      </Pill>
      {schedule.pausedReason && (
        <span className="max-w-[14rem] text-caption font-normal whitespace-normal text-ink-3">
          {t(`reportSchedules.pausedReasons.${schedule.pausedReason}`)}
        </span>
      )}
    </span>
  );
}

// The confirm before a delete. Hard: the schedule goes; files already sent stay on each person's
// Exports page.
function DeleteContent({ schedule, onDone }: { schedule: ReportSchedule; onDone: () => void }) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const words = useScheduleWords();
  const remove = useMutation({
    mutationFn: () => call(routes.reportSchedules.remove, { params: { id: schedule.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['report-schedules', tenantId] });
      toast(t('reportSchedules.deleted', { report: words.report(schedule.report) }));
      onDone();
    },
    onError: (error) => {
      toast(errorText(failureOf(error) ?? 'unknown_error'));
    },
  });
  return (
    <DialogContent
      title={t('reportSchedules.deleteTitle')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            disabled={remove.isPending}
            onClick={() => {
              remove.mutate();
            }}
          >
            {t('reportSchedules.deleteConfirm')}
          </Button>
        </>
      }
    >
      <p className="text-body-sm text-ink-2">{t('reportSchedules.deleteBody')}</p>
    </DialogContent>
  );
}

export function ReportSchedulesPage() {
  const { t, format, errorText } = useLocale();
  const tenantId = useTenantId();
  const can = useCan();
  const canManage = can('core.report.schedule');
  const online = useOnline();
  const queryClient = useQueryClient();
  const words = useScheduleWords();
  const list = useQuery({ ...reportSchedulesQuery(tenantId), enabled: canManage && online });
  const [acting, setActing] = useState<Acting | null>(null);

  // Pause and Resume go at once, with the version the row was read at: someone else's change in
  // between is refused (version_conflict) instead of overwritten
  const toggle = useMutation({
    mutationFn: (schedule: ReportSchedule) =>
      schedule.status === 'active'
        ? call(routes.reportSchedules.pause, {
            params: { id: schedule.id },
            body: { version: schedule.version },
          })
        : call(routes.reportSchedules.resume, {
            params: { id: schedule.id },
            body: { version: schedule.version },
          }),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['report-schedules', tenantId] });
      const report = words.report(saved.report);
      toast(
        saved.status === 'active'
          ? t('reportSchedules.resumed', { report })
          : t('reportSchedules.paused', { report }),
      );
    },
    onError: (error) => {
      toast(errorText(failureOf(error) ?? 'unknown_error'));
    },
  });

  // mutate is stable; the mutation object is new on every render and would rebuild the columns
  const { mutate: toggleSchedule, isPending: toggling } = toggle;
  const timeZone = list.data?.timeZone ?? 'UTC';
  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('report', {
          // Not sortable: at most 20, in the order they were made. Without this on every column
          // the DataTable would sort in the browser and show sort buttons.
          enableSorting: false,
          header: t('reportSchedules.columns.report'),
          meta: { card: 'title' },
          cell: ({ row }) => {
            const schedule = row.original;
            const fileWord = isExportFormat(schedule.format)
              ? t(`reports.formats.${schedule.format}`)
              : schedule.format;
            return (
              <span className="flex items-start gap-3">
                <NameTile
                  icon={
                    isReportKind(schedule.report)
                      ? REPORT_ICONS[schedule.report]
                      : CalendarClockIcon
                  }
                  brand
                />
                <span className="grid min-w-0">
                  <span className="font-medium text-ink">{words.report(schedule.report)}</span>
                  {words.filterLines(schedule).map((line) => (
                    <span key={line} className="text-caption font-normal text-ink-3">
                      {line}
                    </span>
                  ))}
                  <span className="text-caption font-normal text-ink-3">
                    {`${fileWord} · ${t('reportSchedules.createdBy', { name: schedule.createdByName })}`}
                  </span>
                </span>
              </span>
            );
          },
        }),
        column.accessor('when', {
          enableSorting: false,
          header: t('reportSchedules.columns.when'),
          meta: { card: 'detail' },
          cell: ({ getValue }) => words.when(getValue()),
        }),
        column.accessor('recipients', {
          enableSorting: false,
          header: t('reportSchedules.columns.recipients'),
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const recipients = getValue();
            const left = recipients.filter((person) => !person.canReceive).length;
            return (
              <span className="grid justify-items-start">
                {t('reportSchedules.recipientCount', { count: recipients.length })}
                {/* Someone on it who left or lost the report's permission gets nothing */}
                {left > 0 && (
                  <span className="flex items-center gap-1 text-caption font-medium text-warn">
                    <HugeiconsIcon icon={Alert02Icon} size={13} strokeWidth={1.5} />
                    {t('reportSchedules.cannotReceiveCount', { count: left })}
                  </span>
                )}
              </span>
            );
          },
        }),
        column.accessor('nextRunAt', {
          enableSorting: false,
          header: t('reportSchedules.columns.nextRun'),
          meta: { card: 'detail' },
          cell: ({ row }) => {
            const { nextRunAt, lastRunAt } = row.original;
            return (
              <span className="grid tabular-nums">
                {nextRunAt === null ? (
                  <span className="text-ink-3">—</span>
                ) : (
                  <span className="whitespace-nowrap">
                    {format.dateTime(new Date(nextRunAt), timeZone)}
                  </span>
                )}
                <span className="text-caption text-ink-3">
                  {lastRunAt === null
                    ? t('reportSchedules.notSentYet')
                    : t('reportSchedules.lastRun', {
                        date: format.dateTime(new Date(lastRunAt), timeZone),
                      })}
                </span>
              </span>
            );
          },
        }),
        column.accessor('status', {
          enableSorting: false,
          header: t('reportSchedules.columns.status'),
          meta: { card: 'subtitle' },
          cell: ({ row }) => <StatusCell schedule={row.original} />,
        }),
        column.display({
          id: 'actions',
          header: () => <span className="sr-only">{t('reportSchedules.columns.actions')}</span>,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ row }) => {
            const schedule = row.original;
            const paused = schedule.status === 'paused';
            return (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    icon={MoreHorizontalIcon}
                    label={t('reportSchedules.actionsFor', {
                      report: words.report(schedule.report),
                    })}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    icon={PencilEdit02Icon}
                    onSelect={() => {
                      setActing({ kind: 'edit', schedule });
                    }}
                  >
                    {t('reportSchedules.edit')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={paused ? PlayIcon : PauseIcon}
                    disabled={toggling}
                    onSelect={() => {
                      toggleSchedule(schedule);
                    }}
                  >
                    {paused ? t('reportSchedules.resume') : t('reportSchedules.pause')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    icon={Delete02Icon}
                    onSelect={() => {
                      setActing({ kind: 'delete', schedule });
                    }}
                  >
                    {t('reportSchedules.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            );
          },
        }),
      ]),
    [t, format, timeZone, words, toggleSchedule, toggling],
  );

  const header = (
    <PageHeader title={t('reportSchedules.title')} description={t('reportSchedules.description')} />
  );
  if (!canManage) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        {header}
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'core.report.schedule' })}
        </p>
      </div>
    );
  }

  const items = list.data?.items;
  const editing = acting?.kind === 'edit' ? acting.schedule : null;
  const editingReport = editing && isReportKind(editing.report) ? editing.report : null;
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      {header}
      {!online ? (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('reports.needsConnection')}
        />
      ) : list.isError ? (
        <p className="text-body-sm text-crit">{t('reportSchedules.loadFailed')}</p>
      ) : (
        items && (
          <>
            {items.length > 0 && (
              <p className="-mt-2 text-label font-normal text-ink-3 tabular-nums">
                {t('reportSchedules.count', {
                  count: format.number(items.length),
                  max: format.number(MAX_REPORT_SCHEDULES),
                })}
              </p>
            )}
            <DataTable
              label={t('reportSchedules.title')}
              data={items}
              columns={columns}
              getRowId={(item) => item.id}
              empty={
                <EmptyState
                  icon={CalendarClockIcon}
                  title={t('reportSchedules.emptyTitle')}
                  description={t('reportSchedules.emptyBody')}
                />
              }
            />
          </>
        )
      )}
      {editing && editingReport && (
        <Suspense fallback={null}>
          <ReportScheduleDialog
            target={{ kind: 'edit', schedule: editing, report: editingReport }}
            onClose={() => {
              setActing(null);
            }}
          />
        </Suspense>
      )}
      {acting?.kind === 'delete' && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setActing(null);
          }}
        >
          <DeleteContent
            schedule={acting.schedule}
            onDone={() => {
              setActing(null);
            }}
          />
        </Dialog>
      )}
    </div>
  );
}
