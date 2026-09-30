import { CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { Card, PageHeader } from '@omnivo/ui';
import { Link } from '@tanstack/react-router';

import { useCan } from '../lib/permissions';
import { useSession } from '../lib/session-store';

// টিমের তালিকা ধাপ ৭-এ নিজের পেজে (/team) সরেছে — ড্যাশবোর্ডে এখন শুধু শুরুর কার্ড, আর আসল সংখ্যা
// আসবে ধাপ ২১-এ
export function DashboardPage() {
  const { t, format } = useLocale();
  const can = useCan();
  const me = useSession((state) => state.me);
  if (!me) return null;

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
        {can('core.user.invite') && (
          <Link
            to="/team"
            className="mt-4 inline-block font-medium text-brand underline-offset-[3px] hover:underline"
          >
            {t('dashboard.invite')}
          </Link>
        )}
      </Card>
    </div>
  );
}
