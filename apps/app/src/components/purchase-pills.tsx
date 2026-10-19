import {
  ArrowTurnBackwardIcon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  DeliveryTruck01Icon,
  FileEditIcon,
  MinusSignCircleIcon,
  PackageReceiveIcon,
  ShoppingCart01Icon,
  ShoppingCartCheck01Icon,
  StopCircleIcon,
  Time04Icon,
  Undo02Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import type {
  ApprovalRoundStatus,
  PurchaseOrderStatus,
  RequisitionOrderState,
  RequisitionStatus,
  StockDocumentStatus,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Pill, type PillTone } from '@omnivo/ui';

import { isOrderLate, type StepState } from '../lib/purchase';

// The status pills of the purchase documents (step 17a), a file of their own like sales-pills.tsx:
// a list page needs these, not the approval card. Never colour alone: each pill has its icon and
// its words. Waiting is work in progress, so brand, not warn (CLAUDE.md → Sales document statuses).

const REQUISITION_PILLS = {
  draft: { tone: 'neutral', icon: FileEditIcon },
  pending: { tone: 'brand', icon: Clock01Icon },
  approved: { tone: 'good', icon: CheckmarkCircle02Icon },
  // Step 17b: the rest will not be ordered (a sales order's Closed)
  closed: { tone: 'neutral', icon: StopCircleIcon },
  cancelled: { tone: 'neutral', icon: CancelCircleIcon },
} as const satisfies Record<RequisitionStatus, { tone: PillTone; icon: IconSvgElement }>;

export function RequisitionStatusPill({ status }: { status: RequisitionStatus }) {
  const { t } = useLocale();
  const { tone, icon } = REQUISITION_PILLS[status];
  return (
    <Pill tone={tone} icon={icon}>
      {t(`requisitions.statuses.${status}`)}
    </Pill>
  );
}

// Step 17b: how much of an approved requisition purchase orders cover, a second pill beside its
// status. Partly ordered is work in progress (brand); nothing ordered shows no pill, like a challan
// nothing came back from.
const ORDER_STATE_PILLS = {
  partly_ordered: { tone: 'brand', icon: ShoppingCart01Icon },
  ordered: { tone: 'good', icon: ShoppingCartCheck01Icon },
} as const satisfies Record<
  Exclude<RequisitionOrderState, 'not_ordered'>,
  { tone: PillTone; icon: IconSvgElement }
>;

export function RequisitionOrderPill({ state }: { state: RequisitionOrderState }) {
  const { t } = useLocale();
  if (state === 'not_ordered') return null;
  const { tone, icon } = ORDER_STATE_PILLS[state];
  return (
    <Pill tone={tone} icon={icon}>
      {t(`requisitions.orderStates.${state}`)}
    </Pill>
  );
}

// A purchase order (step 17b). Approved is good, like an approved requisition: the approval is
// done. Partly received takes its place once goods came (brand: the rest is still coming), like a
// sales order's Partly delivered.
const ORDER_PILLS = {
  draft: { tone: 'neutral', icon: FileEditIcon },
  pending: { tone: 'brand', icon: Clock01Icon },
  approved: { tone: 'good', icon: CheckmarkCircle02Icon },
  received: { tone: 'good', icon: PackageReceiveIcon },
  closed: { tone: 'neutral', icon: StopCircleIcon },
  cancelled: { tone: 'neutral', icon: CancelCircleIcon },
} as const satisfies Record<PurchaseOrderStatus, { tone: PillTone; icon: IconSvgElement }>;

// Its status, and a second warn pill when it is late: the buyer should call the supplier
export function PurchaseOrderStatusPills({
  order,
  today,
}: {
  order: { status: PurchaseOrderStatus; partlyReceived: boolean; expectedDate: string | null };
  today: string;
}) {
  const { t } = useLocale();
  const pill = ORDER_PILLS[order.status];
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {order.partlyReceived ? (
        <Pill tone="brand" icon={DeliveryTruck01Icon}>
          {t('purchaseOrders.partlyReceived')}
        </Pill>
      ) : (
        <Pill tone={pill.tone} icon={pill.icon}>
          {t(`purchaseOrders.statuses.${order.status}`)}
        </Pill>
      )}
      {isOrderLate(order, today) && (
        <Pill tone="warn" icon={Time04Icon}>
          {t('purchaseOrders.late')}
        </Pill>
      )}
    </span>
  );
}

// A goods receipt: a draft, or posted (a delivery's pills)
export function GoodsReceiptStatusPill({ status }: { status: StockDocumentStatus }) {
  const { t } = useLocale();
  return status === 'draft' ? (
    <Pill tone="neutral" icon={FileEditIcon}>
      {t('goodsReceipts.statuses.draft')}
    </Pill>
  ) : (
    <Pill tone="good" icon={CheckmarkCircle02Icon}>
      {t('goodsReceipts.statuses.posted')}
    </Pill>
  );
}

// A round of an approval. Rejected is warn: the person who wrote the document must change it and
// submit it again. Reopened is neutral: its writer took it back on purpose.
const ROUND_PILLS = {
  pending: { tone: 'brand', icon: Clock01Icon },
  approved: { tone: 'good', icon: CheckmarkCircle02Icon },
  rejected: { tone: 'warn', icon: ArrowTurnBackwardIcon },
  reopened: { tone: 'neutral', icon: Undo02Icon },
} as const satisfies Record<ApprovalRoundStatus, { tone: PillTone; icon: IconSvgElement }>;

export function RoundStatusPill({ status }: { status: ApprovalRoundStatus }) {
  const { t } = useLocale();
  const { tone, icon } = ROUND_PILLS[status];
  return (
    <Pill tone={tone} icon={icon}>
      {t(`approvals.rounds.${status}`)}
    </Pill>
  );
}

// A step of a round: approved, sent back, waiting now, or not reached (neutral, with a minus: no
// decision was made)
const STEP_PILLS = {
  approved: { tone: 'good', icon: CheckmarkCircle02Icon },
  rejected: { tone: 'warn', icon: ArrowTurnBackwardIcon },
  waiting: { tone: 'brand', icon: Clock01Icon },
  notYet: { tone: 'neutral', icon: MinusSignCircleIcon },
  notDecided: { tone: 'neutral', icon: MinusSignCircleIcon },
} as const satisfies Record<StepState, { tone: PillTone; icon: IconSvgElement }>;

export function StepStatePill({ state }: { state: StepState }) {
  const { t } = useLocale();
  const { tone, icon } = STEP_PILLS[state];
  return (
    <Pill tone={tone} icon={icon}>
      {t(`approvals.steps.${state}`)}
    </Pill>
  );
}
