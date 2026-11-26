import {
  Alert02Icon,
  CancelCircleIcon,
  Clock01Icon,
  DeliveryBox01Icon,
  DeliveryDelay01Icon,
  DeliveryReturn01Icon,
  DeliveryTracking01Icon,
  DeliveryTruck01Icon,
  PackageDeliveredIcon,
  PackageIcon,
  PackageMovingIcon,
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

// Step 28a.6: the pill of each of the twelve parcel statuses (approved with the mockup). Moved
// here from storefront-order-parcels.tsx in step 28c: the new payout lists parcels too, and that
// file (the parcel cards, Book courier, the label) would ride in its chunk. Work on its way is brand, as
// the order's own pills (CLAUDE.md → Sales document statuses); delivered is good; a failed booking
// is crit, because nothing moves until someone books it again; warn for what the shop must act on
// (the courier holds it, it comes back, part of it came back); over and done is neutral. The
// courier's news on the card use the same icons, so a step reads the same in both places
export const PARCEL_PILLS = {
  booking: { tone: 'brand', icon: Clock01Icon },
  booking_failed: { tone: 'crit', icon: Alert02Icon },
  booked: { tone: 'brand', icon: DeliveryBox01Icon },
  picked_up: { tone: 'brand', icon: PackageMovingIcon },
  in_transit: { tone: 'brand', icon: DeliveryTruck01Icon },
  out_for_delivery: { tone: 'brand', icon: DeliveryTracking01Icon },
  delivered: { tone: 'good', icon: PackageDeliveredIcon },
  partly_delivered: { tone: 'warn', icon: PackageRemoveIcon },
  on_hold: { tone: 'warn', icon: DeliveryDelay01Icon },
  returning: { tone: 'warn', icon: DeliveryReturn01Icon },
  returned: { tone: 'neutral', icon: PackageReceiveIcon },
  cancelled: { tone: 'neutral', icon: CancelCircleIcon },
} as const satisfies Record<
  ShipmentStatus,
  { tone: 'brand' | 'good' | 'warn' | 'crit' | 'neutral'; icon: IconSvgElement }
>;

export function ParcelPill({ status }: { status: ShipmentStatus }) {
  const { t } = useLocale();
  const pill = PARCEL_PILLS[status];
  return (
    <Pill tone={pill.tone} icon={pill.icon}>
      {t(`storefront.order.parcels.statuses.${status}`)}
    </Pill>
  );
}
