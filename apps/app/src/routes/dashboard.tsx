import { CheckmarkCircle02Icon, UserMultipleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { memberListResponseSchema, type MemberListResponse } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card, DataTable, dataTableColumns, PageHeader, SectionHeader } from '@omnivo/ui';
import { useEffect, useMemo, useState } from 'react';

import { apiFetch } from '../lib/api';
import { useSession } from '../lib/session-store';

type Member = MemberListResponse['members'][number];

// module-level: প্রতি render-এ নতুন helper বানানোর দরকার নেই
const column = dataTableColumns<Member>();

function MembersCard({ tenantId }: { tenantId: string }) {
  const { t } = useLocale();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [failed, setFailed] = useState(false);

  // tenantId বদলালে (switcher) আবার আনা; পুরনো request-এর উত্তর দেরিতে এলে ফেলে দেওয়া
  useEffect(() => {
    let cancelled = false;
    apiFetch('/members', memberListResponseSchema).then(
      (response) => {
        if (!cancelled) {
          setMembers(response.members);
          setFailed(false);
        }
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

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
      {failed ? (
        <p className="text-body-sm text-crit">{t('dashboard.teamLoadFailed')}</p>
      ) : (
        members && (
          <DataTable
            label={t('dashboard.teamTitle')}
            data={members}
            columns={columns}
            getRowId={(member) => member.membershipId}
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
        <MembersCard tenantId={me.tenant.id} />
      ) : (
        <p className="flex items-center gap-2 text-body-sm text-ink-3">
          <HugeiconsIcon icon={UserMultipleIcon} size={16} strokeWidth={1.5} />
          {t('dashboard.teamPermissionHint')}
        </p>
      )}
    </div>
  );
}
