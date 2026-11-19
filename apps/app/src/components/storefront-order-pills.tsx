import {
  Alert02Icon,
  CancelCircleIcon,
  Clock01Icon,
  DeliveryTruck01Icon,
  PackageDeliveredIcon,
  PackageIcon,
  PackageReceiveIcon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import type { StorefrontOrderStatus } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Pill } from '@omnivo/ui';

// Step 27b: a shop order's pills, for the list and the order's page. A file of their own, not
// storefront-parts.tsx: the other Storefront pages load that file, and the listing editor sits at
// its chunk budget.

// The status pill (approved with the mockup). Work in progress is brand, not warn (CLAUDE.md →
// Sales document statuses): New waits for the packer, which is the shop's normal day. Returned is
// step 28's, here so a returned order in the All tab already has its pill
const ORDER_PILLS = {
  confirmed: { tone: 'brand', icon: Clock01Icon },
  packed: { tone: 'brand', icon: PackageIcon },
  shipped: { tone: 'brand', icon: DeliveryTruck01Icon },
  delivered: { tone: 'good', icon: PackageDeliveredIcon },
  cancelled: { tone: 'neutral', icon: CancelCircleIcon },
  returned: { tone: 'neutral', icon: PackageReceiveIcon },
} as const satisfies Record<
  StorefrontOrderStatus,
  { tone: 'brand' | 'good' | 'neutral'; icon: IconSvgElement }
>;

export function OrderStatusPill({ status }: { status: StorefrontOrderStatus }) {
  const { t } = useLocale();
  const pill = ORDER_PILLS[status];
  return (
    <Pill tone={pill.tone} icon={pill.icon}>
      {t(`storefront.orders.statuses.${status}`)}
    </Pill>
  );
}

// Decision 16: the sales order could not be made. crit: nothing moves on until someone acts
export function NeedsAttentionPill() {
  const { t } = useLocale();
  return (
    <Pill tone="crit" icon={Alert02Icon}>
      {t('storefront.orders.needsAttention')}
    </Pill>
  );
}
