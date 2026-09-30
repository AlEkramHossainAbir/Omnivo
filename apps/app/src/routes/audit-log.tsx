import { FilterHorizontalIcon, WorkHistoryIcon } from '@hugeicons/core-free-icons';
import {
  AUDIT_ENTITY_TYPES,
  type AuditEntityType,
  type AuditEntry,
  type AuditValue,
  DEFAULT_SETTINGS,
  isAuditAction,
  routes,
} from '@omnivo/contracts';
import { i18n, type Messages, useLocale } from '@omnivo/i18n';
import { DataTable, dataTableColumns, EmptyState, PageHeader, SelectField } from '@omnivo/ui';
import {
  infiniteQueryOptions,
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<AuditEntry>();

type Filter = AuditEntityType | 'all';
type AuditField = keyof Messages['audit']['fields'];

function isFilter(value: string): value is Filter {
  return value === 'all' || AUDIT_ENTITY_TYPES.some((type) => type === value);
}

// changes-এর ঘরের নাম অনুবাদে আছে কি না — runtime-এ i18n নিজেই জানে। নতুন সার্ভারের অচেনা ঘর হলে
// কাঁচা নামটাই দেখায়, ভাঙে না (action-এর মতোই, contracts/audit.ts)
function isAuditField(field: string): field is AuditField {
  return i18n.exists(`audit.fields.${field}`);
}

function auditQuery(tenantId: string, filter: Filter) {
  return infiniteQueryOptions({
    queryKey: ['audit-logs', tenantId, filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.audit.list, {
        query: {
          limit: 50,
          ...(filter !== 'all' && { entityType: filter }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}

export function AuditLogPage() {
  const { t, format } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const canRead = useCan()('core.audit.read');
  const [filter, setFilter] = useState<Filter>('all');
  // "কখন" টেন্যান্টের টাইমজোনে — settings না আসা পর্যন্ত বাংলাদেশের ডিফল্ট
  const timeZone = useQuery(settingsQuery(tenantId)).data?.timezone ?? DEFAULT_SETTINGS.timezone;
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...auditQuery(tenantId, filter),
    enabled: canRead,
  });
  const entries = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(() => {
    const show = (value: AuditValue) => (value === null || value === '' ? '—' : String(value));
    return column.columns([
      column.accessor((entry) => entry.actor?.fullName ?? t('audit.system'), {
        id: 'who',
        header: t('audit.columns.who'),
        // পাতায় পাতায় আসা তালিকা ক্লায়েন্টে sort করলে শুধু আনা রো সাজাত — ভুল ফল (ধাপ ৫)। সার্ভার
        // সবসময় নতুন আগে দেয়, তাই হেডারে sort বাটনই নেই
        enableSorting: false,
        meta: { card: 'title' },
        // CLAUDE.md → Table: প্রথম কলাম ৩০px tile + নাম + ink-3 সাব-লাইন (এখানে সময়)
        cell: ({ getValue, row }) => (
          <span className="flex items-center gap-3">
            <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-caption font-semibold text-brand">
              {initials(getValue())}
            </span>
            <span className="min-w-0">
              <span className="block truncate font-medium">{getValue()}</span>
              <span className="block truncate text-caption text-ink-3 tabular-nums">
                {format.dateTime(new Date(row.original.createdAt), timeZone)}
              </span>
            </span>
          </span>
        ),
      }),
      column.accessor('action', {
        header: t('audit.columns.what'),
        enableSorting: false,
        meta: { card: 'subtitle' },
        cell: ({ getValue }) => {
          const action = getValue();
          return isAuditAction(action) ? t(`audit.actions.${action}`) : action;
        },
      }),
      column.accessor('changes', {
        header: t('audit.columns.changes'),
        enableSorting: false,
        meta: { card: 'detail' },
        // "নাম: Chattogram depot → Chattogram port depot" — প্রতিটা বদলানো ঘর আলাদা লাইনে
        cell: ({ getValue }) => {
          const changes = Object.entries(getValue());
          if (changes.length === 0) return <span className="text-ink-3">—</span>;
          return (
            <ul className="grid gap-0.5">
              {changes.map(([field, change]) => (
                <li key={field} className="truncate">
                  <span className="text-ink-3">
                    {isAuditField(field) ? t(`audit.fields.${field}`) : field}:
                  </span>{' '}
                  {show(change.from)} → {show(change.to)}
                </li>
              ))}
            </ul>
          );
        },
      }),
    ]);
  }, [t, format, timeZone]);

  const filterOptions = useMemo(
    () => [
      { value: 'all', label: t('audit.everything') },
      ...AUDIT_ENTITY_TYPES.map((type) => ({ value: type, label: t(`audit.entityTypes.${type}`) })),
    ],
    [t],
  );

  return (
    <div className="grid max-w-5xl gap-5">
      <PageHeader title={t('audit.title')} description={t('audit.description')} />
      {!canRead ? (
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'core.audit.read' })}
        </p>
      ) : (
        <>
          <div className="max-w-xs">
            <SelectField
              label={t('audit.show')}
              icon={FilterHorizontalIcon}
              options={filterOptions}
              value={filter}
              onChange={(event) => {
                if (isFilter(event.target.value)) setFilter(event.target.value);
              }}
            />
          </div>
          {isError && <p className="text-body-sm text-crit">{t('audit.loadFailed')}</p>}
          {entries && (
            <DataTable
              label={t('audit.title')}
              data={entries}
              columns={columns}
              getRowId={(entry) => entry.id}
              onEndReached={loadMore}
              empty={
                <EmptyState
                  icon={WorkHistoryIcon}
                  title={t('audit.emptyTitle')}
                  description={t('audit.emptyBody')}
                />
              }
              footer={
                isFetchingNextPage && (
                  <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                )
              }
            />
          )}
        </>
      )}
    </div>
  );
}
