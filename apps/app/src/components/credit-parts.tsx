import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { absMoney, isNegativeMoney, isZeroMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, cn, Dialog, DialogClose, DialogContent } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import { ApiRequestError } from '../lib/api';
import { useCan } from '../lib/permissions';
import { customerCreditQuery } from '../lib/queries';
import { useTenantId } from './stock-parts';

// The credit limit on the order and invoice forms (step 15c): the line under the customer, and the
// dialog that asks before a document goes over the limit.

// "Credit left: ৳35,000 of ৳2,00,000 · ৳40,000 on confirmed orders", under the customer box. The
// same numbers the API checks with (GET /customers/:id/credit). Only for someone who may see what
// a customer owes (sales.customer.balance), like the customer's balance itself.
// Step 18b: an order saved on the device (offline, or for a customer whose changes wait) has no
// credit to show: what the customer owes is on the server, and a draft is checked when it is
// confirmed online. The line says so instead of numbers that may be wrong.
export function CreditLine({
  customerId,
  onDevice = false,
}: {
  customerId: string;
  onDevice?: boolean;
}) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const canSee = useCan()('sales.customer.balance');
  const { data: credit } = useQuery({
    ...customerCreditQuery(tenantId, customerId),
    enabled: canSee && customerId !== '' && !onDevice,
  });
  if (!canSee || customerId === '') return null;
  if (onDevice) return <p className="text-label text-ink-3">{t('customers.credit.offline')}</p>;
  if (!credit) return null;
  const money = (value: string) => format.money(value);
  const over = credit.available !== null && isNegativeMoney(credit.available);
  const main =
    credit.limit === null
      ? t('customers.credit.noLimit')
      : isZeroMoney(credit.limit)
        ? t('customers.credit.cashOnly')
        : over
          ? t('customers.credit.over', { amount: money(absMoney(credit.available ?? '0')) })
          : t('customers.credit.left', {
              amount: money(credit.available ?? '0'),
              limit: money(credit.limit),
            });
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 text-label',
        over ? 'font-medium text-crit' : 'text-ink-3',
      )}
    >
      {/* Over the limit is the one state that needs attention: an icon, not colour alone */}
      {over && (
        <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="mt-px shrink-0" />
      )}
      <span className="tabular-nums">
        {main}
        {!isZeroMoney(credit.onOrder) &&
          ` · ${t('customers.credit.onOrder', { amount: money(credit.onOrder) })}`}
      </span>
    </p>
  );
}

// What the API said when a document would go over the limit (409 credit_limit_exceeded): the
// limit and what the customer would owe with this document
export interface CreditStop {
  limit: string;
  exposure: string;
}

export function creditStopOf(error: unknown): CreditStop | null {
  if (!(error instanceof ApiRequestError) || error.code !== 'credit_limit_exceeded') return null;
  const limit = error.problem.params?.limit;
  const exposure = error.problem.params?.exposure;
  return typeof limit === 'string' && typeof exposure === 'string' ? { limit, exposure } : null;
}

// The two credit errors as text, with their amounts as money ("৳2,35,000.00", not
// "235000.0000"). The form puts the text where it puts any other error. null for any other error.
export function useCreditText(): (error: unknown) => string | null {
  const { errorText, format } = useLocale();
  return useCallback(
    (error: unknown) => {
      const stop = creditStopOf(error);
      if (stop !== null) {
        return errorText('credit_limit_exceeded', {
          limit: format.money(stop.limit, { decimals: 2 }),
          exposure: format.money(stop.exposure, { decimals: 2 }),
        });
      }
      if (error instanceof ApiRequestError && error.code === 'credit_override_forbidden') {
        return errorText(error.code, error.problem.params);
      }
      return null;
    },
    [errorText, format],
  );
}

// Asked when the person may go over the limit (sales.credit.override). "Confirm anyway" sends the
// same request again with overrideCreditLimit: true; the API checks the limit again and writes the
// override in the audit log. Paisa: the two amounts may differ by less than a taka.
export function CreditLimitDialog({
  stop,
  customer,
  confirmLabel,
  pending,
  onConfirm,
  onClose,
}: {
  stop: CreditStop | null;
  customer: string;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t, format } = useLocale();
  const money = (value: string) => format.money(value, { decimals: 2 });
  return (
    <Dialog
      open={stop !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {stop !== null && (
        <DialogContent
          title={t('creditLimit.title')}
          description={t('creditLimit.counts')}
          footer={
            <>
              <DialogClose asChild>
                <Button variant="secondary">{t('creditLimit.back')}</Button>
              </DialogClose>
              <Button disabled={pending} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </>
          }
        >
          <div className="grid gap-3 text-body-sm">
            <p className="text-ink tabular-nums">
              {t('creditLimit.body', {
                customer,
                exposure: money(stop.exposure),
                limit: money(stop.limit),
              })}
            </p>
            <p className="text-ink-2">{t('creditLimit.audit')}</p>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
