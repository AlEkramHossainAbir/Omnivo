import {
  Cancel01Icon,
  CheckmarkCircle02Icon,
  PlusSignIcon,
  PrinterIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeftRightIcon, InformationCircleIcon } from '@hugeicons/core-free-icons';
import {
  compareMoney,
  isMoneyAmount,
  isZeroMoney,
  MAX_POS_PAYMENTS,
  posChangeOf,
  posReturnInputSchema,
  posSaleInputSchema,
  registerMethods,
  subtractMoney,
  sumMoney,
  type SyncPosRegister,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { type LocalCopy, type PosReturnSave, savePosSale } from '@omnivo/sync';
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
import { exchangeSplit, type ReturnSlipData, returnSlipOf, type UnitOf } from '../lib/pos-returns';
import { DocumentNotice } from './document-notice';
import { hasPaisa, Kbd } from './pos-parts';
import { refundMethodsAt, RefundRows, refundRow, refundValues } from './pos-refund-rows';

// Step 20a: taking the money (decision 5), the sale saved on the device, and what follows.

// A saved sale, for the done dialog and the receipt: the cart as it was paid, with its number
export interface DoneSale {
  number: string;
  // In cash, for the done dialog's "Give back ৳200"
  change: string;
  receipt: ReceiptData;
  // Step 20c: an exchange's return, saved with the sale: its slip prints before the receipt, and
  // the done dialog says what of its money goes back
  returnSlip?: ReturnSlipData;
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
  shiftId,
  cart,
  total,
  date,
  pricesIncludeVat,
  cashier,
  returnNumber,
  unitOf,
  onClose,
  onDone,
}: {
  copy: LocalCopy;
  register: SyncPosRegister;
  // Step 20b: the open shift the sale is made in
  shiftId: string;
  cart: Cart;
  total: string;
  date: string;
  pricesIncludeVat: boolean;
  cashier: string;
  // Step 20c: the number an exchange's return will most likely get ("From return POS1-R000012");
  // the save gives the real one
  returnNumber: string;
  unitOf: UnitOf;
  onClose: () => void;
  onDone: (sale: DoneSale) => void;
}) {
  const { t, format } = useLocale();
  const methods = registerMethods(register.accounts);
  // Step 20c: an exchange's money pays first, up to the total (decision 7). What is left of it goes
  // back now ("Paid back by"); what it does not cover the other rows pay.
  const exchange = cart.exchange ?? null;
  const split = exchange && exchangeSplit(exchange.total, total);
  const credit = split?.used ?? '0';
  const owed = subtractMoney(total, credit);
  const leftOver = split !== null && !isZeroMoney(split.rest);
  const [rows, setRows] = useState<PaymentRow[]>(() =>
    compareMoney(owed, '0') > 0 ? [firstRow()] : [],
  );
  const [restRows, setRestRows] = useState<PaymentRow[]>(() =>
    split && leftOver ? [refundRow('cash', split.rest)] : [],
  );
  // An error code (the schema's, the save's) or a sentence: FormAlert says either
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // A box still being typed counts as 0, like the cart's totals
  const amountOf = (value: string) => (isMoneyAmount(value) ? value : '0');
  const paid = sumMoney([credit, ...rows.map((row) => amountOf(row.amount))]);
  const due = dueOf(rows, owed);
  const change = compareMoney(paid, total) > 0 ? subtractMoney(paid, total) : '0';
  const givenBack = sumMoney(restRows.map((row) => amountOf(row.amount)));

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
  const exact = compareMoney(owed, othersPaid) > 0 ? subtractMoney(owed, othersPaid) : '0';

  // Step 20c: the exchange's return as posReturnInputSchema reads it, its money split between the
  // sale and the rows that pay back what is left. null = no exchange; an error code = not right.
  const returnOf = (soldAt: string): PosReturnSave | string | null => {
    if (!exchange) return null;
    const parsed = posReturnInputSchema.safeParse({
      registerId: register.id,
      sequence: 1,
      shiftId,
      date,
      returnedAt: soldAt,
      saleId: exchange.sale.id,
      lines: exchange.lines,
      refunds: [{ method: 'exchange', amount: credit, reference: '' }, ...refundValues(restRows)],
      note: exchange.note ?? '',
    });
    if (!parsed.success) return parsed.error.issues[0]?.message ?? 'unknown_error';
    // The sequence was only for the check: the save gives the return its number
    return {
      returnId: exchange.returnId,
      input: parsed.data,
      registerCode: register.code,
      savedAt: soldAt,
    };
  };

  const complete = async () => {
    setError(null);
    const soldAt = new Date().toISOString();
    // The same schema the server reads, so a sale the device saves is one the server accepts. The
    // sequence is only for the check: the save gives the sale its number (savePosSale).
    const values = saleValues({
      cart,
      registerId: register.id,
      shiftId,
      date,
      soldAt,
      pricesIncludeVat,
      payments: rows,
    });
    const parsed = posSaleInputSchema.safeParse({
      ...values,
      // Step 20c: the exchange's money first, naming its return
      payments: [
        ...(exchange
          ? [{ method: 'exchange', amount: credit, reference: '', returnId: exchange.returnId }]
          : []),
        ...values.payments,
      ],
      sequence: 1,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'unknown_error');
      return;
    }
    const given = returnOf(soldAt);
    if (typeof given === 'string') {
      setError(given);
      return;
    }
    setSaving(true);
    try {
      const result = await savePosSale(copy, {
        input: parsed.data,
        registerCode: register.code,
        total,
        savedAt: soldAt,
        ...(given && { exchange: given }),
      });
      if (result.kind === 'not-held') {
        setError('pos_register_not_held');
        return;
      }
      // Step 20b: the shift was closed in another tab meanwhile; this screen shows the open card
      if (result.kind === 'no-shift') {
        setError('pos_shift_closed');
        return;
      }
      // Online it goes at once; offline it waits in the outbox (the done dialog says so)
      requestSync();
      const change = posChangeOf(parsed.data.payments, total);
      const returnSlip =
        exchange && given && result.returnNumber !== null
          ? returnSlipOf({
              number: result.returnNumber,
              returnedAt: soldAt,
              register,
              cashier,
              sale: exchange.sale,
              lines: given.input.lines,
              refunds: given.input.refunds,
              usedOn: result.number,
              note: given.input.note,
              unitOf,
            })
          : null;
      onDone({
        number: result.number,
        change,
        ...(returnSlip && { returnSlip }),
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
          {/* Step 20c: the return's money, the first payment, fixed: an exchange is never a
              choice in the select (decision 10) */}
          {exchange && (
            <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[8rem_9rem_minmax(0,1fr)_auto]">
              <span className="flex h-[42px] items-center gap-2 rounded-control border border-line bg-subtle px-3 text-body-sm text-ink-2">
                <HugeiconsIcon
                  icon={ArrowLeftRightIcon}
                  size={17}
                  strokeWidth={1.5}
                  className="text-ink-3"
                />
                {t('pos.methods.exchange')}
              </span>
              <span className="flex h-[42px] items-center justify-end rounded-control border border-line bg-subtle px-3 text-body-sm tabular-nums">
                {money(format, credit)}
              </span>
              <span className="text-label text-ink-2 max-sm:col-span-2">
                {t('pos.exchange.payment', { number: returnNumber })}
              </span>
            </div>
          )}
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
          {/* The notes the customer handed over: one tap, and the change shows. Not when an
              exchange's money pays it all */}
          {compareMoney(owed, '0') > 0 && (
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
                {quickCash(owed).map((amount) => (
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
          )}
          {rows.length > 0 && rows.length < MAX_POS_PAYMENTS && methods.length > 1 && (
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
          {/* Step 20c: a sale smaller than the return: what is left of its money goes back now,
              in this dialog (decision 7) */}
          {exchange && split && leftOver && (
            <div className="grid gap-3">
              <DocumentNotice tone="neutral" icon={InformationCircleIcon}>
                {t('pos.exchange.rest', { amount: money(format, split.rest) })}
              </DocumentNotice>
              <RefundRows
                rows={restRows}
                onRows={setRestRows}
                methods={refundMethodsAt(register, exchange.sale)}
                total={split.rest}
              />
            </div>
          )}
          <dl className="grid gap-1.5 rounded-control bg-subtle px-4 py-3 text-body-sm">
            <SummaryRow label={t('pos.receipt.total')} value={money(format, total)} />
            <SummaryRow label={t('pos.paid')} value={money(format, paid)} />
            {compareMoney(due, '0') > 0 ? (
              <SummaryRow label={t('pos.due')} value={money(format, due)} strong />
            ) : leftOver ? (
              <SummaryRow label={t('pos.return.given')} value={money(format, givenBack)} strong />
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
  // Step 20c: an exchange's money left over goes back too: in cash with the change, or another way
  const refunds = sale.returnSlip?.refunds ?? [];
  const cashBack = sumMoney(
    refunds.filter((refund) => refund.method === 'cash').map((refund) => refund.amount),
  );
  const others = refunds.filter((refund) => refund.method !== 'cash');
  const big = changeDue
    ? t('pos.giveChange', { amount: money(format, sale.change) })
    : !isZeroMoney(cashBack)
      ? t('pos.return.giveCash', { amount: money(format, cashBack) })
      : null;
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
            className={big ? 'text-kpi font-semibold tabular-nums' : 'text-body text-ink-2'}
          >
            {big ?? t('pos.noChange')}
          </p>
          {changeDue && !isZeroMoney(cashBack) && (
            <p className="text-body-sm text-ink-2">
              {t('pos.return.giveCash', { amount: money(format, cashBack) })}
            </p>
          )}
          {others.map((refund, index) => (
            <p key={`${String(index)}-${refund.method}`} className="text-body-sm text-ink-2">
              {t('pos.return.giveOther', {
                amount: money(format, refund.amount),
                method: t(`pos.methods.${refund.method}`),
              })}
            </p>
          ))}
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
    ['F6', t('pos.keys.return')],
    ['F7', t('pos.keys.billDiscount')],
    ['F8', t('pos.keys.hold')],
    ['F9', t('pos.keys.held')],
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
