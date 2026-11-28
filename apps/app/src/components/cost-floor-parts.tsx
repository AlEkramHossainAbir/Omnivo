import { isZeroMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Dialog, DialogClose, DialogContent } from '@omnivo/ui';
import { useCallback } from 'react';

import { ApiRequestError } from '../lib/api';

// The cost floor on the order and invoice forms: the API refuses a document whose lines sell below
// their buying price, plus the lowest margin (409 sales_below_cost). The price boxes of those lines
// get the error; the person with sales.cost.override also gets a dialog that sends the same request
// again with overrideBelowCost: true, like the credit limit's (credit-parts.tsx).

// What the API said: the lines' numbers as the form counts them ("2, 4"), how many, and the margin
export interface CostStop {
  lines: string;
  count: number;
  margin: string;
}

export function costStopOf(error: unknown): CostStop | null {
  if (!(error instanceof ApiRequestError) || error.code !== 'sales_below_cost') return null;
  const lines = error.problem.params?.lines;
  const count = error.problem.params?.count;
  const margin = error.problem.params?.margin;
  return typeof lines === 'string' && typeof count === 'number' && typeof margin === 'string'
    ? { lines, count, margin }
    : null;
}

// The two cost errors as one sentence for the top of the form; null for any other error. The
// price boxes say it too (the field errors), so the sentence names the lines.
export function useCostText(): (error: unknown) => string | null {
  const { t, errorText } = useLocale();
  return useCallback(
    (error: unknown) => {
      const stop = costStopOf(error);
      if (stop !== null) {
        return t('costFloor.blocked', { count: stop.count, lines: stop.lines });
      }
      if (error instanceof ApiRequestError && error.code === 'cost_override_forbidden') {
        return errorText(error.code, error.problem.params);
      }
      return null;
    },
    [t, errorText],
  );
}

// Asked when the person may sell below the buying price (sales.cost.override). The amounts are
// not shown: the cost is the books', and the form already marks the lines.
export function CostFloorDialog({
  stop,
  confirmLabel,
  pending,
  onConfirm,
  onClose,
}: {
  stop: CostStop | null;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t, format } = useLocale();
  // A margin is a decimal string ("5.00"), never a number
  const hasMargin = stop !== null && !isZeroMoney(stop.margin);
  return (
    <Dialog
      open={stop !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {stop !== null && (
        <DialogContent
          title={t('costFloor.title')}
          footer={
            <>
              <DialogClose asChild>
                <Button variant="secondary">{t('costFloor.back')}</Button>
              </DialogClose>
              <Button disabled={pending} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </>
          }
        >
          <div className="grid gap-3 text-body-sm">
            <p className="text-ink tabular-nums">
              {t('costFloor.body', { count: stop.count, lines: stop.lines })}
            </p>
            {hasMargin && (
              <p className="text-ink-2">
                {t('costFloor.margin', { margin: format.number(stop.margin, 2) })}
              </p>
            )}
            <p className="text-ink-2">{t('costFloor.audit')}</p>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
