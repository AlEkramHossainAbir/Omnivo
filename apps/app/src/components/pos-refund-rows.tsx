import { Cancel01Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  compareMoney,
  MAX_POS_PAYMENTS,
  type PosPaymentMethod,
  type PosReturnableSale,
  refundMethodsOf,
  registerMethods,
  type SyncPosRegister,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, IconButton, Input, MoneyInput, Select } from '@omnivo/ui';

import { dueOf, newLineKey, type PaymentRow } from '../lib/pos';

// Step 20c: the rows that pay a return's money back, shared by the return dialog (pos-return.tsx)
// and the pay dialog's money left over from an exchange (pos-pay.tsx). A file of their own: the pay
// dialog's chunk takes these rows only, not the whole return dialog (the budget of routes/pos.tsx).

// Cash first, with the whole amount: most money goes back in cash. Also the pay dialog's first
// "Paid back by" row for an exchange's money left over.
export function refundRow(method: PosPaymentMethod, amount: string): PaymentRow {
  return { key: newLineKey(), method, amount, reference: '' };
}

// The ways the money may go back at this register: cash, and the ways the sale was paid that the
// register takes (decision 18: the server refuses a method the register has no account for)
export function refundMethodsAt(
  register: SyncPosRegister,
  sale: Pick<PosReturnableSale, 'payments'>,
): PosPaymentMethod[] {
  const taken = new Set(registerMethods(register.accounts));
  return refundMethodsOf(sale).filter((method) => taken.has(method));
}

// The refund rows: a select of the methods, the amount, the reference, and a remove button. Also
// the pay dialog's "Paid back by" rows for an exchange's money left over (pos-pay.tsx).
export function RefundRows({
  rows,
  onRows,
  methods,
  total,
}: {
  rows: readonly PaymentRow[];
  onRows: (rows: PaymentRow[]) => void;
  methods: readonly PosPaymentMethod[];
  total: string;
}) {
  const { t } = useLocale();
  const change = (key: string, fields: Partial<PaymentRow>) => {
    onRows(rows.map((row) => (row.key === key ? { ...row, ...fields } : row)));
  };
  const due = dueOf(rows, total);
  return (
    <div className="grid gap-3">
      <ul className="grid gap-3">
        {rows.map((row, index) => {
          const id = `pos-refund-${row.key}`;
          return (
            <li
              key={row.key}
              className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 sm:grid-cols-[8rem_9rem_minmax(0,1fr)_auto]"
            >
              <Select
                id={`${id}-method`}
                aria-label={t('pos.return.method')}
                value={row.method}
                onChange={(event) => {
                  const method = methods.find((one) => one === event.target.value);
                  if (method) change(row.key, { method });
                }}
                options={methods.map((method) => ({
                  value: method,
                  label: t(`pos.methods.${method}`),
                }))}
              />
              <MoneyInput
                id={`${id}-amount`}
                aria-label={t('pos.amount')}
                autoFocus={index === 0}
                value={row.amount}
                onChange={(amount) => {
                  change(row.key, { amount });
                }}
              />
              <Input
                id={`${id}-reference`}
                aria-label={t('pos.reference')}
                placeholder={t(`pos.referencePlaceholders.${row.method}`)}
                value={row.reference}
                onChange={(event) => {
                  change(row.key, { reference: event.target.value });
                }}
              />
              {rows.length > 1 && (
                <IconButton
                  icon={Cancel01Icon}
                  label={t('pos.return.removeRefund', { number: index + 1 })}
                  onClick={() => {
                    onRows(rows.filter((one) => one.key !== row.key));
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
      {rows.length < MAX_POS_PAYMENTS && methods.length > 1 && (
        <Button
          variant="secondary"
          size="sm"
          className="w-fit gap-1.5"
          onClick={() => {
            // The next way no row has yet, with what is still to give back
            const used = new Set(rows.map((row) => row.method));
            const method = methods.find((one) => !used.has(one)) ?? 'cash';
            onRows([...rows, refundRow(method, compareMoney(due, '0') > 0 ? due : '')]);
          }}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
          {t('pos.return.addRefund')}
        </Button>
      )}
    </div>
  );
}

// The rows as posReturnInputSchema reads them (its input: the schema turns '' into null)
export function refundValues(rows: readonly PaymentRow[]) {
  return rows.map((row) => ({ method: row.method, amount: row.amount, reference: row.reference }));
}
