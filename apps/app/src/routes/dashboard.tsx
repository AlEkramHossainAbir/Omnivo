import { CheckmarkCircle02Icon, UserMultipleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { memberListResponseSchema, type MemberListResponse } from '@omnivo/contracts';
import { useEffect, useState } from 'react';

import { apiFetch } from '../lib/api';
import { formatDate } from '../lib/format';
import { useSession } from '../lib/session-store';

function MembersCard({ tenantId }: { tenantId: string }) {
  const [members, setMembers] = useState<MemberListResponse['members'] | null>(null);
  const [failed, setFailed] = useState(false);

  // tenantId বদলালে (switcher) আবার আনা; পুরনো request-এর উত্তর দেরিতে এলে ফেলে দেওয়া
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    apiFetch('/members', memberListResponseSchema).then(
      (response) => {
        if (!cancelled) setMembers(response.members);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  return (
    <section className="rounded-card border border-line bg-surface shadow-sm">
      <header className="px-5 pt-[18px]">
        <h3 className="text-h3">Team</h3>
        <p className="text-label text-ink-3">People with access to this workspace</p>
      </header>
      {failed && (
        <p className="px-5 pt-3 text-body-sm text-crit">
          Couldn&apos;t load your team. Refresh the page to try again.
        </p>
      )}
      <ul className="mt-3 divide-y divide-line border-t border-line">
        {(members ?? []).map((member) => (
          <li key={member.membershipId} className="flex items-center gap-3 px-5 py-3">
            <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-caption font-semibold text-brand">
              {member.fullName.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body-sm font-medium">{member.fullName}</span>
              <span className="block truncate text-caption text-ink-3">{member.email}</span>
            </span>
            <span className="text-caption text-ink-2">{member.roles.join(', ') || 'No role'}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DashboardPage() {
  const me = useSession((state) => state.me);
  if (!me) return null;

  // UI-তে permission দেখে লুকানো শুধু সুবিধা; আসল পাহারা API-র PermissionGuard
  const canSeeTeam = me.permissions.includes('core.user.read');

  return (
    <div className="grid max-w-5xl gap-5">
      <header>
        <h1 className="text-h1">Overview</h1>
        <p className="mt-1 text-label text-ink-3">
          {me.tenant.name} · {formatDate(new Date())}
        </p>
      </header>

      <section className="rounded-card border border-line bg-surface p-8 text-center shadow-sm">
        <span className="mx-auto grid size-[52px] place-items-center rounded-full bg-good-bg text-good">
          <HugeiconsIcon icon={CheckmarkCircle02Icon} size={26} strokeWidth={1.5} />
        </span>
        <h2 className="mt-4 text-h2">Your workspace is ready</h2>
        <p className="mx-auto mt-2 max-w-md text-ink-2">
          Next, set up your chart of accounts and invite your accountant. Buyer POs, LCs and stock
          will show up here once you start recording them.
        </p>
      </section>

      {canSeeTeam ? (
        <MembersCard tenantId={me.tenant.id} />
      ) : (
        <p className="flex items-center gap-2 text-body-sm text-ink-3">
          <HugeiconsIcon icon={UserMultipleIcon} size={16} strokeWidth={1.5} />
          Ask a workspace owner for the core.user.read permission to see your team.
        </p>
      )}
    </div>
  );
}
