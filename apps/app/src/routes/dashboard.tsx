import { CheckmarkCircle02Icon, UserMultipleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type Member, type MemberSort, routes } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Card,
  DataTable,
  dataTableColumns,
  PageHeader,
  SectionHeader,
  type SortingState,
} from '@omnivo/ui';
import { infiniteQueryOptions, keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { call } from '../lib/api';
import { useSession } from '../lib/session-store';

// module-level: প্রতি render-এ নতুন helper বানানোর দরকার নেই
const column = dataTableColumns<Member>();

// query-র key আর কীভাবে আনবে এক জায়গায় — অন্য পেজও (যেমন ধাপ ৭-এর invite মডাল) একই key দিয়ে
// ক্যাশ মুছতে বা আগে থেকে আনতে পারবে
function membersQuery(tenantId: string, sort: MemberSort) {
  return infiniteQueryOptions({
    // tenantId key-তে: workspace বদলালে আগের টেন্যান্টের পাতা এই key-তে কখনো মিলবে না
    queryKey: ['members', tenantId, sort],
    // pageParam-এর টাইপ লেখা: শুধু initialPageParam: null থেকে TanStack ভাবত পাতার cursor সবসময়
    // null, আর getNextPageParam-এর string মেলাত না। এখান থেকে সে string | null শেখে — cast ছাড়া
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.members.list, {
        query: { sort, limit: 50, ...(pageParam !== null && { cursor: pageParam }) },
      }),
    initialPageParam: null,
    // null = শেষ পাতা; TanStack তখন hasNextPage = false
    getNextPageParam: (page) => page.nextCursor,
    // sort বদলালে নতুন key — নতুন পাতা আসা পর্যন্ত আগেরটা দেখানো, টেবিল ফাঁকা হয়ে ঝলকায় না
    placeholderData: keepPreviousData,
  });
}

function MembersSection({ tenantId }: { tenantId: string }) {
  const { t } = useLocale();
  const [sort, setSort] = useState<MemberSort>('name');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    membersQuery(tenantId, sort),
  );

  // সব পাতা জোড়া একটা তালিকা; data না বদলালে একই array, তাই টেবিল অকারণে আবার হিসাব করে না
  const members = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);

  const loadMore = useCallback(() => {
    // চলতি request শেষ না হলে আবার না — নাহলে একই cursor দুবার চাওয়া হতো
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // টেবিলের sort অবস্থা ↔ API-র sort প্যারামিটার। শুধু নাম-কলাম সার্ভারে sort হয়
  const sorting = useMemo(
    () => ({
      state: [{ id: 'fullName', desc: sort === '-name' }],
      onChange: (next: SortingState) => {
        setSort(next[0]?.desc ? '-name' : 'name');
      },
    }),
    [sort],
  );

  // header-এ অনুবাদ আছে, তাই ভাষা (t) বদলালে column নতুন করে; নাহলে একই array — টেবিল আবার হিসাব করে না
  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('fullName', {
          header: t('dashboard.columns.member'),
          meta: { card: 'title' },
          // CLAUDE.md → Table: প্রথম কলামে ৩০px avatar tile + নাম + ink-3 সাব-লাইন
          cell: ({ row }) => (
            <span className="flex items-center gap-3">
              <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-caption font-semibold text-brand">
                {row.original.fullName.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{row.original.fullName}</span>
                <span className="block truncate text-caption text-ink-3">{row.original.email}</span>
              </span>
            </span>
          ),
        }),
        column.accessor((member) => member.roles.join(', '), {
          id: 'roles',
          header: t('dashboard.columns.roles'),
          // সার্ভার রোল দিয়ে সাজাতে পারে না (চুক্তিতে শুধু name) — তাই হেডারে sort বাটনই নেই
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => getValue() || t('dashboard.noRole'),
        }),
      ]),
    [t],
  );

  return (
    // DataTable নিজেই কার্ড — তাই Card-এ না মুড়ে শুধু শিরোনাম + টেবিল
    <section className="grid gap-3">
      <SectionHeader title={t('dashboard.teamTitle')} subtitle={t('dashboard.teamSubtitle')} />
      {isError ? (
        <p className="text-body-sm text-crit">{t('dashboard.teamLoadFailed')}</p>
      ) : (
        members && (
          <DataTable
            label={t('dashboard.teamTitle')}
            data={members}
            columns={columns}
            getRowId={(member) => member.membershipId}
            sorting={sorting}
            onEndReached={loadMore}
            footer={
              isFetchingNextPage && (
                <p className="text-caption text-ink-3">{t('dashboard.loadingMore')}</p>
              )
            }
          />
        )
      )}
    </section>
  );
}

export function DashboardPage() {
  const { t, format } = useLocale();
  const me = useSession((state) => state.me);
  if (!me) return null;

  // UI-তে permission দেখে লুকানো শুধু সুবিধা; আসল পাহারা API-র PermissionGuard
  const canSeeTeam = me.permissions.includes('core.user.read');

  return (
    <div className="grid max-w-5xl gap-5">
      <PageHeader
        title={t('dashboard.title')}
        description={`${me.tenant.name} · ${format.date(new Date())}`}
      />

      <Card className="p-8 text-center">
        <span className="mx-auto grid size-[52px] place-items-center rounded-full bg-good-bg text-good">
          <HugeiconsIcon icon={CheckmarkCircle02Icon} size={26} strokeWidth={1.5} />
        </span>
        <h2 className="mt-4 text-h2">{t('dashboard.readyTitle')}</h2>
        <p className="mx-auto mt-2 max-w-md text-ink-2">{t('dashboard.readyBody')}</p>
      </Card>

      {canSeeTeam ? (
        <MembersSection tenantId={me.tenant.id} />
      ) : (
        <p className="flex items-center gap-2 text-body-sm text-ink-3">
          <HugeiconsIcon icon={UserMultipleIcon} size={16} strokeWidth={1.5} />
          {t('dashboard.teamPermissionHint')}
        </p>
      )}
    </div>
  );
}
