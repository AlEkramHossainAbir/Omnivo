import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Download04Icon,
  FileDownloadIcon,
  Pdf01Icon,
  Xls01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  DEFAULT_SETTINGS,
  isExportFormat,
  isReportKind,
  type ReportExport,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  PageHeader,
  Pill,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useIsoDate } from '../components/journal-parts';
import { call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { reportExportsQuery, settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<ReportExport>();

function StatusPill({ status }: { status: ReportExport['status'] }) {
  const { t } = useLocale();
  if (status === 'ready') {
    return (
      <Pill tone="good" icon={CheckmarkCircle02Icon}>
        {t('exports.statuses.ready')}
      </Pill>
    );
  }
  if (status === 'failed') {
    return (
      <Pill tone="crit" icon={Alert02Icon}>
        {t('exports.statuses.failed')}
      </Pill>
    );
  }
  return (
    <Pill tone="warn" icon={Clock01Icon}>
      {t('exports.statuses.pending')}
    </Pill>
  );
}

export function ReportExportsPage() {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('accounting.report.read');
  const showDate = useIsoDate();
  const { data, isError } = useQuery({ ...reportExportsQuery(tenantId), enabled: canRead });
  const timeZone = useQuery(settingsQuery(tenantId)).data?.timezone ?? DEFAULT_SETTINGS.timezone;

  // A fresh short-lived link each time, so a link from an old page never lasts. A click on a
  // hidden <a download>, not a page change: the storage sends the file as an attachment under its
  // own name, and the page stays where it is (the mock's same-origin blob takes the name from the
  // download attribute instead).
  const download = useMutation({
    mutationFn: async (item: ReportExport) => ({
      item,
      signed: await call(routes.reportExports.download, { params: { id: item.id } }),
    }),
    onSuccess: ({ item, signed }) => {
      const link = document.createElement('a');
      link.href = signed.url;
      link.download = item.fileName ?? '';
      link.click();
    },
    onError: () => {
      toast(t('exports.downloadFailed'));
    },
  });

  const columns = useMemo(() => {
    // "1 Jul 2026 – 30 Sep 2026" or "As at 30 Sep 2026", from the query the page sent
    const period = (query: Record<string, string>) => {
      if (query.asOf !== undefined) return t('reports.asAt', { date: showDate(query.asOf) });
      if (query.from !== undefined && query.to !== undefined) {
        return t('reports.range', { from: showDate(query.from), to: showDate(query.to) });
      }
      return '';
    };
    return column.columns([
      column.accessor('report', {
        header: t('exports.columns.report'),
        enableSorting: false,
        meta: { card: 'title' },
        cell: ({ row }) => (
          <span className="grid">
            <span className="font-medium text-ink">
              {/* A report this app does not know yet (a newer server): its raw name */}
              {isReportKind(row.original.report)
                ? t(`reports.kinds.${row.original.report}`)
                : row.original.report}
            </span>
            <span className="text-caption text-ink-3 tabular-nums">
              {period(row.original.query)}
            </span>
          </span>
        ),
      }),
      column.accessor('format', {
        header: t('exports.columns.format'),
        enableSorting: false,
        meta: { card: 'detail' },
        cell: ({ getValue }) => {
          const value = getValue();
          return (
            <span className="inline-flex items-center gap-1.5">
              <HugeiconsIcon
                icon={value === 'pdf' ? Pdf01Icon : Xls01Icon}
                size={16}
                strokeWidth={1.5}
                className="text-ink-3"
              />
              {isExportFormat(value) ? t(`reports.formats.${value}`) : value}
            </span>
          );
        },
      }),
      column.accessor('createdAt', {
        header: t('exports.columns.created'),
        enableSorting: false,
        meta: { card: 'subtitle' },
        cell: ({ getValue }) => (
          <span className="tabular-nums">{format.dateTime(new Date(getValue()), timeZone)}</span>
        ),
      }),
      column.accessor('status', {
        header: t('exports.columns.status'),
        enableSorting: false,
        meta: { card: 'detail' },
        cell: ({ getValue }) => <StatusPill status={getValue()} />,
      }),
      column.display({
        id: 'download',
        header: () => <span className="sr-only">{t('exports.download')}</span>,
        // On a phone's card: top right, where an action needs no label
        meta: { align: 'end', card: 'trailing' },
        cell: ({ row }) =>
          row.original.status === 'ready' ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={download.isPending}
              onClick={() => {
                download.mutate(row.original);
              }}
            >
              <HugeiconsIcon icon={Download04Icon} size={16} strokeWidth={1.5} />
              {t('exports.download')}
            </Button>
          ) : null,
      }),
    ]);
  }, [t, format, showDate, timeZone, download]);

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader title={t('exports.title')} description={t('exports.description')} />
      {!canRead ? (
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.report.read' })}
        </p>
      ) : (
        <>
          {isError && <p className="text-body-sm text-crit">{t('exports.loadFailed')}</p>}
          {data && (
            <DataTable
              label={t('exports.title')}
              data={data}
              columns={columns}
              getRowId={(item) => item.id}
              empty={
                <EmptyState
                  icon={FileDownloadIcon}
                  title={t('exports.emptyTitle')}
                  description={t('exports.emptyBody')}
                />
              }
            />
          )}
        </>
      )}
    </div>
  );
}
