import { zodResolver } from '@hookform/resolvers/zod';
import {
  type ApprovalDocument,
  type ApprovalRound,
  type ApprovalStep,
  approveInputSchema,
  contractErrorMap,
  rejectInputSchema,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, DialogClose, DialogContent, FormAlert, TextAreaField, toast } from '@omnivo/ui';
import { useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { postsWhenApproved } from '../lib/purchase';
import { usePurchaseRefresh } from './purchase-parts';

// Approve and Reject (step 17a), a lazy chunk of its own (approval-card.tsx says why). One dialog
// for every kind of document: the path names the kind, the body the round the card showed
// (decision 16). If the document was reopened and submitted again meanwhile, the server answers
// approval_not_pending, and the person reads the new round before deciding.

interface DecisionProps {
  document: ApprovalDocument;
  id: string;
  number: string;
  round: ApprovalRound;
  // The step waiting now: the one this person decides
  step: ApprovalStep;
  roleName: string;
  onDone: () => void;
}

// The errors that belong to no box: approval_not_pending, approval_not_allowed,
// approval_own_document, a role taken away since the page loaded
const FIELD_NAMES = ['comment'] as const;

function ApproveForm({ document, id, number, round, step, roleName, onDone }: DecisionProps) {
  const { t } = useLocale();
  const refresh = usePurchaseRefresh();
  const last = step.position === round.steps.length;
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(approveInputSchema, { error: contractErrorMap }),
    defaultValues: { roundId: round.id, comment: '' },
  });

  const onSubmit = handleSubmit(async (body) => {
    try {
      await call(routes.approvals.approve, { params: { document, id }, body });
      await refresh();
      toast(t('approvals.approvedToast', { number }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  return (
    <DialogContent
      title={t('approvals.approveTitle', { number })}
      description={t('approvals.approveBody', {
        position: step.position,
        count: round.steps.length,
        role: roleName,
      })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="approve-form" disabled={isSubmitting}>
            {t('approvals.confirmApprove')}
          </Button>
        </>
      }
    >
      <form
        id="approve-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {/* Whether this click finishes the approval or passes it to the next level */}
        <p className="text-body-sm text-ink-2">
          {/* Step 17c: the last approval of a bill or a payment posts it (decision 7) */}
          {last
            ? postsWhenApproved(document)
              ? t('approvals.approveLastPosts', { number })
              : t('approvals.approveLast', { number })
            : t('approvals.approveNext')}
        </p>
        <TextAreaField
          label={t('approvals.comment')}
          optional
          placeholder={t('approvals.approveCommentPlaceholder')}
          {...register('comment')}
          error={errors.comment?.message}
        />
      </form>
    </DialogContent>
  );
}

function RejectForm({ document, id, number, round, onDone }: DecisionProps) {
  const { t } = useLocale();
  const refresh = usePurchaseRefresh();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(rejectInputSchema, { error: contractErrorMap }),
    defaultValues: { roundId: round.id, comment: '' },
  });

  const onSubmit = handleSubmit(async (body) => {
    try {
      await call(routes.approvals.reject, { params: { document, id }, body });
      await refresh();
      toast(t('approvals.rejectedToast', { number }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  return (
    <DialogContent
      title={t('approvals.rejectTitle', { number })}
      description={t('approvals.rejectBody', { name: round.submittedBy.name })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="reject-form" disabled={isSubmitting}>
            {t('approvals.confirmReject')}
          </Button>
        </>
      }
    >
      <form
        id="reject-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {/* Required: the writer must know what to change (decision 15) */}
        <TextAreaField
          label={t('approvals.rejectComment')}
          placeholder={t('approvals.rejectCommentPlaceholder')}
          {...register('comment')}
          error={errors.comment?.message}
        />
      </form>
    </DialogContent>
  );
}

export function DecisionDialog({
  decision,
  ...props
}: DecisionProps & { decision: 'approve' | 'reject' }) {
  return decision === 'approve' ? <ApproveForm {...props} /> : <RejectForm {...props} />;
}
