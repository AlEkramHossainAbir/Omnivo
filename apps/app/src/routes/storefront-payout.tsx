import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, type ReactNode, Suspense } from 'react';

import { useToday } from '../components/stock-parts';
import { PayoutBackLink } from '../components/storefront-payout-parts';
import { StorefrontOffline } from '../components/storefront-parts';
import { storefrontPayoutQuery, storefrontPayoutSetupQuery } from '../lib/storefront-payouts';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 28c: a new payout (/storefront/payouts/new, "Record payout" in a courier account's row menu
// comes with ?account=) and a payout's page. Each in its own chunk, like the money receipt's: the
// form brings the date picker and the parcels table, the page the print sheet.

const PayoutForm = lazy(async () => ({
  default: (await import('../components/storefront-payout-form')).PayoutForm,
}));
const PayoutView = lazy(async () => ({
  default: (await import('../components/storefront-payout-view')).PayoutView,
}));

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PayoutBackLink />
      {children}
    </div>
  );
}

export function NewStorefrontPayoutPage() {
  const online = useOnline();
  const today = useToday();
  const { account = '' } = useSearch({ strict: false });
  const { data: setup } = useQuery({
    ...storefrontPayoutSetupQuery(useTenantId()),
    enabled: online,
  });
  if (!online) {
    return (
      <Frame>
        <StorefrontOffline />
      </Frame>
    );
  }
  if (!setup) return null;
  // An account the address names that is not in the setup (another workspace's, or a typo) starts
  // the form empty instead of asking the API for its parcels
  const start = setup.accounts.some((choice) => choice.id === account) ? account : '';
  return (
    <Suspense fallback={null}>
      <PayoutForm setup={setup} accountId={start} today={today} />
    </Suspense>
  );
}

export function StorefrontPayoutPage() {
  const { t } = useLocale();
  const online = useOnline();
  const today = useToday();
  const { payoutId = '' } = useParams({ strict: false });
  const { data: payout, isError } = useQuery({
    ...storefrontPayoutQuery(useTenantId(), payoutId),
    enabled: online && payoutId !== '',
  });
  if (!online) {
    return (
      <Frame>
        <StorefrontOffline />
      </Frame>
    );
  }
  if (isError) {
    return (
      <Frame>
        <EmptyState
          icon={AlertCircleIcon}
          title={t('storefront.payouts.title')}
          description={t('storefront.payout.notFound')}
        />
      </Frame>
    );
  }
  if (!payout) return null;
  return (
    <Suspense fallback={null}>
      <PayoutView payout={payout} today={today} />
    </Suspense>
  );
}
