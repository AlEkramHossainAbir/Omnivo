import {
  Alert02Icon,
  CancelCircleIcon,
  Clock01Icon,
  DeliveryReturn01Icon,
  DeliveryTruck01Icon,
  PackageDeliveredIcon,
  PackageIcon,
  PackageReceiveIcon,
  PackageRemoveIcon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import type { ShipmentStatus, StorefrontOrderStatus } from '@omnivo/contracts';
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

// Step 28b (mine 40, approved with the mockup): a second, warn pill on a shipped order whose newest
// parcel did not all reach the shopper. The staff act once the goods are back (Record what came
// back, Receive the return), so warn. The parcel card's icons, so a step reads the same in both
// places. Only these two: the courier's other steps are its own work
const PARCEL_WAIT_PILLS = {
  partly_delivered: PackageRemoveIcon,
  returning: DeliveryReturn01Icon,
} as const satisfies Partial<Record<ShipmentStatus, IconSvgElement>>;

export function ParcelWaitPill({
  status,
  parcelStatus,
}: {
  status: StorefrontOrderStatus;
  parcelStatus: ShipmentStatus | null;
}) {
  const { t } = useLocale();
  if (status !== 'shipped') return null;
  if (parcelStatus !== 'partly_delivered' && parcelStatus !== 'returning') return null;
  return (
    <Pill tone="warn" icon={PARCEL_WAIT_PILLS[parcelStatus]}>
      {t(`storefront.orders.parcelPills.${parcelStatus}`)}
    </Pill>
  );
}
