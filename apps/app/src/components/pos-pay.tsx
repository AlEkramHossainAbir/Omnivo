import {
  Cancel01Icon,
  CheckmarkCircle02Icon,
  PlusSignIcon,
  PrinterIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  compareMoney,
  isMoneyAmount,
  MAX_POS_PAYMENTS,
  posChangeOf,
  posSaleInputSchema,
  registerMethods,
  subtractMoney,
  sumMoney,
  type SyncPosRegister,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { type LocalCopy, savePosSale } from '@omnivo/sync';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  IconButton,
  Input,
  MoneyInput,
  Select,
} from '@omnivo/ui';
import { useState } from 'react';

import { requestSync } from '../lib/local-data';
import {
  type Cart,
  dueOf,
  newLineKey,
  type PaymentRow,
  quickCash,
  type ReceiptData,
  receiptOfCart,
  saleValues,
} from '../lib/pos';
import { hasPaisa, Kbd } from './pos-parts';

// Step 20a: taking the money (decision 5), the sale saved on the device, and what follows.

// A saved sale, for the done dialog and the receipt: the cart as it was paid, with its number
export interface DoneSale {
  number: string;
  // In cash, for the done dialog's "Give back ৳200"
  change: string;
  receipt: ReceiptData;
}

function money(format: ReturnType<typeof useLocale>['format'], value: string): string {
  return format.money(value, { decimals: hasPaisa(value) ? 2 : 0 });
}

// Cash first, empty: the cashier types what the customer handed over, or taps a note
function firstRow(): PaymentRow {
  return { key: newLineKey(), method: 'cash', amount: '', reference: '' };
}

export function PayDialog({
  copy,
  register,
  cart,
  total,
  date,
  pricesIncludeVat,
  cashier,
  onClose,
  onDone,
}: {
  copy: LocalCopy;
  register: SyncPosRegister;
  cart: Cart;
  total: string;
  date: string;
  pricesIncludeVat: boolean;
  cashier: string;
  onClose: () => void;
  onDone: (sale: DoneSale) => void;
}) {
  const { t, format } = useLocale();
  const methods = registerMethods(register.accounts);
  const [rows, setRows] = useState<PaymentRow[]>(() => [firstRow()]);
  // An error code (the schema's, the save's) or a sentence: FormAlert says either
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // A box still being typed counts as 0, like the cart's totals
  const amountOf = (value: string) => (isMoneyAmount(value) ? value : '0');
  const paid = sumMoney(rows.map((row) => amountOf(row.amount)));
  const due = dueOf(rows, total);
  const change = compareMoney(paid, total) > 0 ? subtractMoney(paid, total) : '0';

  const changeRow = (key: string, change: Partial<PaymentRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  };
  // The cash row the note chips fill: the first one, or a new one when there is none
  const cashRow = rows.find((row) => row.method === 'cash');
  const setCash = (amount: string) => {
    if (cashRow) changeRow(cashRow.key, { amount });
    else setRows((current) => [...current, { ...firstRow(), amount }]);
  };
  // "Exact amount": the cash row pays what the other rows leave
  const othersPaid = sumMoney(
    rows.filter((row) => row !== cashRow).map((row) => amountOf(row.amount)),
  );
  const exact = compareMoney(total, othersPaid) > 0 ? subtractMoney(total, othersPaid) : '0';

  const complete = async () => {
    setError(null);
    const soldAt = new Date().toISOString();
    // The same schema the server reads, so a sale the device saves is one the server accepts. The
    // sequence is only for the check: the save gives the sale its number (savePosSale).
    const parsed = posSaleInputSchema.safeParse({
      ...saleValues({
        cart,
        registerId: register.id,
        date,
        soldAt,
        pricesIncludeVat,
        payments: rows,
      }),
      sequence: 1,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'unknown_error');
      return;
    }
    setSaving(true);
    try {
      const result = await savePosSale(copy, {
        input: parsed.data,
        registerCode: register.code,
        total,
        savedAt: soldAt,
      });
      if (result.kind === 'not-held') {
        setError('pos_register_not_held');
        return;
      }
      // Online it goes at once; offline it waits in the outbox (the done dialog says so)
      requestSync();
      const change = posChangeOf(parsed.data.payments, total);
      onDone({
        number: result.number,
        change,
        receipt: receiptOfCart({
          number: result.number,
          soldAt,
          register,
          cashier,
          cart,
          pricesIncludeVat,
          payments: parsed.data.payments,
          paid: sumMoney(parsed.data.payments.map((payment) => payment.amount)),
          change,
        }),
      });
    } catch {
      setError(t('sync.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        title={t('pos.payTitle')}
        description={t('pos.payDescription', { total: money(format, total) })}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={saving}>
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" form="pos-pay" disabled={saving} className="gap-2">
              {saving ? t('pos.completing') : t('pos.complete')}
              <Kbd>Enter</Kbd>
            </Button>
          </>
        }
      >
        {/* A form, so Enter in any box completes the sale (decision 12) */}
        <form
          id="pos-pay"
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!saving) void complete();
          }}
        >
          {error && <FormAlert message={error} />}
          <ul className="grid gap-3">
            {rows.map((row, index) => {
              const id = `pos-pay-${row.key}`;
              return (
                <li
                  key={row.key}
                  className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 sm:grid-cols-[8rem_9rem_minmax(0,1fr)_auto]"
                >
                  <Select
                    id={`${id}-method`}
                    aria-label={t('pos.method')}
                    value={row.method}
                    onChange={(event) => {
                      const method = methods.find((one) => one === event.target.value);
                      if (method) changeRow(row.key, { method });
                    }}
                    options={methods.map((method) => ({
                      value: method,
                      label: t(`pos.methods.${method}`),
                    }))}
                  />
                  <MoneyInput
                    id={`${id}-amount`}
                    aria-label={t('pos.amount')}
                    // The first box takes the focus: the cashier types the amount at once
                    autoFocus={index === 0}
                    value={row.amount}
                    onChange={(amount) => {
                      changeRow(row.key, { amount });
                    }}
                  />
                  <Input
                    id={`${id}-reference`}
                    aria-label={t('pos.reference')}
                    placeholder={t(`pos.referencePlaceholders.${row.method}`)}
                    value={row.reference}
                    onChange={(event) => {
                      changeRow(row.key, { reference: event.target.value });
                    }}
                  />
                  {rows.length > 1 && (
                    <IconButton
                      icon={Cancel01Icon}
                      label={t('pos.removePayment', { number: index + 1 })}
                      onClick={() => {
                        setRows((current) => current.filter((one) => one.key !== row.key));
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          {/* The notes the customer handed over: one tap, and the change shows */}
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-label font-medium">{t('pos.quickCash')}</legend>
            <div className="flex flex-wrap gap-2">
              <Chip
                onClick={() => {
                  setCash(exact);
                }}
              >
                {t('pos.exact')}
              </Chip>
              {quickCash(total).map((amount) => (
                <Chip
                  key={amount}
                  onClick={() => {
                    setCash(amount);
                  }}
                >
                  {format.money(amount)}
                </Chip>
              ))}
            </div>
          </fieldset>
          {rows.length < MAX_POS_PAYMENTS && methods.length > 1 && (
            <Button
              variant="secondary"
              size="sm"
              className="w-fit gap-1.5"
              onClick={() => {
                // The next method this register takes that no row has yet, else cash again
                const used = new Set(rows.map((row) => row.method));
                const method = methods.find((one) => !used.has(one)) ?? 'cash';
                // It starts with what is still to pay: a card is charged the exact rest
                setRows((current) => [
                  ...current,
                  { ...firstRow(), method, amount: compareMoney(due, '0') > 0 ? due : '' },
                ]);
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('pos.addPayment')}
            </Button>
          )}
          <dl className="grid gap-1.5 rounded-control bg-subtle px-4 py-3 text-body-sm">
            <SummaryRow label={t('pos.receipt.total')} value={money(format, total)} />
            <SummaryRow label={t('pos.paid')} value={money(format, paid)} />
            {compareMoney(due, '0') > 0 ? (
              <SummaryRow label={t('pos.due')} value={money(format, due)} strong />
            ) : (
              <SummaryRow label={t('pos.change')} value={money(format, change)} strong />
            )}
          </dl>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SummaryRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong ? 'font-medium text-ink' : 'text-ink-2'}>{label}</dt>
      <dd className={strong ? 'text-h3 font-semibold tabular-nums' : 'tabular-nums'}>{value}</dd>
    </div>
  );
}

// A filter chip's look (CLAUDE.md → Filter chips): radius 8px, a line-strong border
function Chip({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-9 rounded-lg border border-line-strong bg-surface px-3 text-body-sm font-medium tabular-nums transition-colors duration-150 hover:bg-subtle"
    >
      {children}
    </button>
  );
}

// After the sale: the change to give back, big, because the cashier reads it with the customer
// waiting. The receipt has gone to the printer already. Enter starts the next sale (the button
// has the focus); closing the dialog any way does the same.
export function DoneDialog({
  sale,
  offline,
  onPrint,
  onNew,
}: {
  sale: DoneSale;
  offline: boolean;
  onPrint: () => void;
  onNew: () => void;
}) {
  const { t, format } = useLocale();
  const changeDue = compareMoney(sale.change, '0') > 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onNew();
      }}
    >
      <DialogContent
        title={t('pos.doneTitle', { number: sale.number })}
        footer={
          <>
            <Button variant="secondary" className="mr-auto gap-1.5" onClick={onPrint}>
              <HugeiconsIcon icon={PrinterIcon} size={17} strokeWidth={1.5} />
              {t('pos.printAgain')}
            </Button>
            <Button autoFocus onClick={onNew} className="gap-2">
              {t('pos.newSale')}
              <Kbd>Enter</Kbd>
            </Button>
          </>
        }
      >
        <div className="grid justify-items-center gap-3 py-2 text-center">
          <span className="grid size-10 place-items-center rounded-lg bg-good-bg text-good">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={20} strokeWidth={1.5} />
          </span>
          <p
            role="status"
            className={changeDue ? 'text-kpi font-semibold tabular-nums' : 'text-body text-ink-2'}
          >
            {changeDue
              ? t('pos.giveChange', { amount: money(format, sale.change) })
              : t('pos.noChange')}
          </p>
          {offline && <p className="text-label text-ink-3">{t('pos.savedOnDevice')}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// "?" on the screen: every key the counter uses
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const keys = [
    ['F2', t('pos.keys.search')],
    ['F4', t('pos.keys.customer')],
    ['F7', t('pos.keys.billDiscount')],
    ['F12', t('pos.keys.pay')],
    ['Enter', t('pos.keys.complete')],
    ['Enter', t('pos.keys.newSale')],
    ['?', t('pos.keys.help')],
  ] as const;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent title={t('pos.shortcuts')}>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 text-body-sm">
          {keys.map(([key, label]) => (
            <div key={label} className="contents">
              <dt>
                <kbd className="rounded-[5px] border border-line-strong bg-subtle px-1.5 font-mono text-caption text-ink-2">
                  {key}
                </kbd>
              </dt>
              <dd className="text-ink-2">{label}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
