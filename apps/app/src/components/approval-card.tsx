import { ArrowTurnBackwardIcon, CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type ApprovalDocument,
  type ApprovalRound,
  type ApprovalStep,
  DEFAULT_SETTINGS,
  type DocumentApproval,
  levelsFor,
  waitingStep,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, Dialog } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';

import { approvedByOwnSubmit, postsWhenApproved, roundNumber, stepState } from '../lib/purchase';
import { approvalRulesQuery, settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { RoundStatusPill, StepStatePill } from './purchase-pills';

// The approve and reject dialogs as a chunk of their own: they bring the form library, which a
// person who only reads the document never needs
const DecisionDialog = lazy(async () => ({
  default: (await import('./approval-dialogs')).DecisionDialog,
}));

// "Purchase manager", or "Director (a deleted role)" when the role was deleted after the document
// was submitted: the step kept its name (decision 25)
function useRoleName(): (step: ApprovalStep) => string {
  const { t } = useLocale();
  return (step) =>
    step.role.id === null ? t('approvals.deletedRole', { name: step.role.name }) : step.role.name;
}

function Round({
  round,
  number,
  timeZone,
  posts,
}: {
  round: ApprovalRound;
  number: number;
  timeZone: string;
  // Step 17c: the document is posted, not only approved (a bill, a supplier payment)
  posts: boolean;
}) {
  const { t, format } = useLocale();
  const roleName = useRoleName();
  const when = (iso: string) => format.dateTime(new Date(iso), timeZone);
  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body-sm font-medium">{t('approvals.round', { number })}</span>
        <RoundStatusPill status={round.status} />
      </div>
      <p className="text-label text-ink-3">
        {t('approvals.submitted', {
          name: round.submittedBy.name,
          date: when(round.submittedAt),
          amount: format.money(round.amount),
        })}
      </p>
      {round.steps.length === 0 ? (
        // No level applied to its amount: approved at once (decision 13), and a bill or a payment
        // posted at once (17c)
        <p className="text-body-sm text-ink-2">
          {posts ? t('approvals.noLevelsPosted') : t('approvals.noLevels')}
        </p>
      ) : (
        <ol className="grid grid-cols-1 rounded-control border border-line">
          {round.steps.map((step) => (
            <li
              key={step.position}
              className="grid grid-cols-1 gap-1 border-t border-line px-4 py-3 first:border-t-0"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-body-sm text-ink">
                  {t('approvals.levelLine', {
                    role: roleName(step),
                    amount: format.money(step.minAmount),
                  })}
                </span>
                <StepStatePill state={stepState(round, step)} />
              </div>
              {step.decidedBy !== null && step.decidedAt !== null && (
                <span className="text-caption text-ink-3 tabular-nums">
                  {t('approvals.decided', {
                    name: step.decidedBy.name,
                    date: when(step.decidedAt),
                  })}
                </span>
              )}
              {/* A rejection always says why (decision 15); an approval may add a note */}
              {step.comment !== null && <q className="text-body-sm text-ink-2">{step.comment}</q>}
            </li>
          ))}
        </ol>
      )}
      {approvedByOwnSubmit(round) && (
        <p className="text-body-sm text-ink-2">
          {posts ? t('approvals.ownerSubmittedPosted') : t('approvals.ownerSubmitted')}
        </p>
      )}
    </div>
  );
}

// A document's approval, for any kind (decision 30): every round it went through, newest first,
// what waits now, and Approve and Reject for the person who may decide the waiting step. A draft
// also lists the levels its amount reaches today (decision 13 copies them when it is submitted).
export function ApprovalCard({
  document,
  id,
  number,
  amount,
  draft,
  approval,
}: {
  document: ApprovalDocument;
  id: string;
  number: string;
  // The document's amount now (a draft's next round would start from it)
  amount: string;
  draft: boolean;
  approval: DocumentApproval;
}) {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const meId = useSession((state) => state.me?.user.id);
  const roleName = useRoleName();
  const timeZone = useQuery(settingsQuery(tenantId)).data?.timezone ?? DEFAULT_SETTINGS.timezone;
  const rules = useQuery({ ...approvalRulesQuery(tenantId), enabled: draft }).data;
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null);
  const [current, ...earlier] = approval.rounds;
  const waiting = current ? waitingStep(current) : null;
  // The levels a draft would need if it were submitted now
  const preview = draft
    ? levelsFor(rules?.find((rule) => rule.document === document)?.levels ?? [], amount)
    : [];

  return (
    <Card>
      <CardHeader title={t('approvals.cardTitle')} subtitle={t('approvals.cardSubtitle')} />
      <div className="grid grid-cols-1 gap-5 p-5">
        {draft && (
          <div className="grid grid-cols-1 gap-2">
            <p className="text-body-sm text-ink-2">{t('approvals.notSubmitted')}</p>
            {preview.length > 0 && (
              <ol className="grid list-decimal grid-cols-1 gap-1 pl-5 text-body-sm text-ink">
                {preview.map((level) => (
                  <li key={level.role.id}>
                    {t('approvals.levelLine', {
                      role: level.role.name,
                      amount: format.money(level.minAmount),
                    })}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        {current && (
          <Round
            round={current}
            number={roundNumber(approval.rounds, 0)}
            timeZone={timeZone}
            posts={postsWhenApproved(document)}
          />
        )}
        {current && waiting && (
          <div className="grid grid-cols-1 gap-3 rounded-control bg-subtle px-4 py-3">
            <p className="text-body-sm text-ink-2">
              {approval.canDecide
                ? t('approvals.waitingForYou', { position: waiting.position })
                : current.submittedBy.id === meId
                  ? t('approvals.ownDocument')
                  : t('approvals.waitingFor', { role: roleName(waiting) })}
            </p>
            {approval.canDecide && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setDeciding('approve');
                  }}
                >
                  <HugeiconsIcon icon={CheckmarkCircle02Icon} size={16} strokeWidth={1.5} />
                  {t('approvals.approve')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setDeciding('reject');
                  }}
                >
                  <HugeiconsIcon icon={ArrowTurnBackwardIcon} size={16} strokeWidth={1.5} />
                  {t('approvals.reject')}
                </Button>
              </div>
            )}
          </div>
        )}
        {earlier.length > 0 && (
          // Folded: the round now is what a person came for; the history is one click away
          <details className="grid grid-cols-1 gap-4 border-t border-line pt-4">
            <summary className="text-label font-medium text-brand underline-offset-3 hover:underline">
              {t('approvals.earlierRounds')}
            </summary>
            <div className="mt-4 grid grid-cols-1 gap-5">
              {earlier.map((round, index) => (
                <Round
                  key={round.id}
                  round={round}
                  number={roundNumber(approval.rounds, index + 1)}
                  timeZone={timeZone}
                  posts={postsWhenApproved(document)}
                />
              ))}
            </div>
          </details>
        )}
      </div>

      <Dialog
        open={deciding !== null}
        onOpenChange={(open) => {
          if (!open) setDeciding(null);
        }}
      >
        {deciding !== null && current && waiting && (
          <Suspense fallback={null}>
            <DecisionDialog
              decision={deciding}
              document={document}
              id={id}
              number={number}
              round={current}
              step={waiting}
              roleName={roleName(waiting)}
              onDone={() => {
                setDeciding(null);
              }}
            />
          </Suspense>
        )}
      </Dialog>
    </Card>
  );
}
