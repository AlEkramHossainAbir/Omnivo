import {
  ArrowTurnBackwardIcon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  FileEditIcon,
  MinusSignCircleIcon,
  Undo02Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import type { ApprovalRoundStatus, RequisitionStatus } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Pill, type PillTone } from '@omnivo/ui';

import type { StepState } from '../lib/purchase';

// The status pills of the purchase documents (step 17a), a file of their own like sales-pills.tsx:
// a list page needs these, not the approval card. Never colour alone: each pill has its icon and
// its words. Waiting is work in progress, so brand, not warn (CLAUDE.md → Sales document statuses).

const REQUISITION_PILLS = {
  draft: { tone: 'neutral', icon: FileEditIcon },
  pending: { tone: 'brand', icon: Clock01Icon },
  approved: { tone: 'good', icon: CheckmarkCircle02Icon },
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
