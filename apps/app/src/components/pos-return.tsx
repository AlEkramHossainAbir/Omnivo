import {
  ArrowLeftRightIcon,
  BarCode01Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  MinusSignIcon,
  PlusSignIcon,
  PrinterIcon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  addQuantity,
  compareQuantity,
  isMoneyAmount,
  isQuantity,
  isZeroMoney,
  lastReturnDayOf,
  POS_SALES_ON_DEVICE_DAYS,
  type PosReturnableLine,
  type PosReturnableSale,
  type PosReturnLineInput,
  posReturnInputSchema,
  returnableQuantityOf,
  routes,
  subtractQuantity,
  sumMoney,
  type SyncPosRegister,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  type DeviceShift,
  type LocalCopy,
  localSale,
  newReturnId,
  type PosCartExchange,
  savePosReturn,
  withWaitingReturns,
} from '@omnivo/sync';
import {
  Button,
  Checkbox,
  CheckboxGroup,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  Input,
  parseIsoDate,
} from '@omnivo/ui';
import { useState } from 'react';

import { ApiRequestError, call } from '../lib/api';
import { requestSync, withSyncLock } from '../lib/local-data';
import { dueOf, type PaymentRow } from '../lib/pos';
import {
  firstPick,
  hasLeft,
  picksProblem,
  plainQuantity,
  type ReturnPick,
  type ReturnPicks,
  type ReturnSlipData,
  returnLineOf,
  returnLinesOf,
  returnSlipOf,
  returnTotalOf,
  saleProblem,
  serialsLeft,
  type UnitOf,
} from '../lib/pos-returns';
import { useOnline } from '../lib/use-online';
import { DocumentNotice } from './document-notice';
import { hasPaisa, Kbd } from './pos-parts';
import { refundMethodsAt, RefundRows, refundRow, refundValues } from './pos-refund-rows';

// Step 20c: taking goods back at the counter (F6, the top bar's Return): find the receipt, tick
// what came back, pay the money back, or use it on a new sale (an exchange). One dialog that goes
// through the three steps, then the done dialog; the slip prints by itself. Its own chunk, loaded
// the first time it opens (routes/pos.tsx's budget).

// A saved return, for the done dialog and its slip
export interface DoneReturn {
  number: string;
  slip: ReturnSlipData;
}

type Step =
  | { step: 'find' }
  | { step: 'lines'; sale: PosReturnableSale }
  | {
      step: 'refund';
      sale: PosReturnableSale;
      lines: PosReturnLineInput[];
      note: string;
    };

function screenMoney(format: ReturnType<typeof useLocale>['format'], value: string): string {
  return format.money(value, { decimals: hasPaisa(value) ? 2 : 0 });
}

// Online: the server, for any register's receipt, with what came back of it at every counter.
// Offline, or when the server does not have it (sold offline, not synced yet) or does not answer:
// this register's own sales on the device. Either way with the returns still in this device's
// outbox, which no server has counted yet. Step 20c.7: the server is asked inside the sync lock,
// so no push runs meanwhile: a return in the outbox then never reached the server, or went with
// a push whose answer was lost (withWaitingReturns leaves those out). Without the lock, a second
// return right after the first was counted twice, or not at all, by the moment of the push.
async function findSale(
  copy: LocalCopy,
  number: string,
  online: boolean,
): Promise<PosReturnableSale | null> {
  if (online) {
    try {
      // A holder, not a `let`: the lock runs the function, which TypeScript cannot follow
      const found: { sale: PosReturnableSale | null } = { sale: null };
      await withSyncLock(async () => {
        const sale = await call(routes.posReturns.returnableSale, { params: { number } });
        found.sale = await withWaitingReturns(copy, sale, true);
      });
      if (found.sale) return found.sale;
    } catch (error) {
      if (error instanceof ApiRequestError && error.code !== 'pos_return_sale_not_found') {
        throw error;
      }
    }
  }
  const sale = await localSale(copy, number);
  return sale && withWaitingReturns(copy, sale);
}

// The ticks of a return that comes back from an exchange the cashier dropped
function picksOf(lines: readonly PosReturnLineInput[]): ReturnPicks {
  return Object.fromEntries(
    lines.map((line) => [
      line.saleLineId,
      { quantity: line.quantity, serials: line.serialNumbers },
    ]),
  );
}

export function ReturnDialog({
  copy,
  register,
  shift,
  today,
  cashier,
  timeZone,
  canReturn,
  stopped,
  unitOf,
  dropped,
  onClose,
  onDone,
  onExchange,
}: {
  copy: LocalCopy;
  register: SyncPosRegister;
  shift: DeviceShift;
  today: string;
  cashier: string;
  // The workspace's, for "Sold 28 Oct 2026, 4:12 pm"
  timeZone: string;
  // pos.return.create
  canReturn: boolean;
  // Why no new work is taken now (the 7-day limit offline, a shift left open on an earlier day):
  // the screen's own notice, said here too. null = none.
  stopped: string | null;
  unitOf: UnitOf;
  // An exchange the cashier dropped: the return starts again at paying the money back
  dropped: PosCartExchange | null;
  onClose: () => void;
  onDone: (done: DoneReturn) => void;
  onExchange: (exchange: PosCartExchange) => void;
}) {
  const [step, setStep] = useState<Step>(() =>
    dropped
      ? {
          step: 'refund',
          sale: dropped.sale,
          lines: dropped.lines,
          note: dropped.note ?? '',
        }
      : { step: 'find' },
  );
  const [picks, setPicks] = useState<ReturnPicks>(() => (dropped ? picksOf(dropped.lines) : {}));
  const [note, setNote] = useState(dropped?.note ?? '');
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      {step.step === 'find' && (
        <FindStep
          copy={copy}
          register={register}
          today={today}
          canReturn={canReturn}
          stopped={stopped}
          onFound={(sale) => {
            setPicks({});
            setNote('');
            setStep({ step: 'lines', sale });
          }}
        />
      )}
      {step.step === 'lines' && (
        <LinesStep
          sale={step.sale}
          register={register}
          timeZone={timeZone}
          unitOf={unitOf}
          picks={picks}
          onPicks={setPicks}
          note={note}
          onNote={setNote}
          onNext={(lines) => {
            setStep({ step: 'refund', sale: step.sale, lines, note });
          }}
        />
      )}
      {step.step === 'refund' && (
        <RefundStep
          copy={copy}
          register={register}
          shift={shift}
          today={today}
          cashier={cashier}
          sale={step.sale}
          lines={step.lines}
          note={step.note}
          unitOf={unitOf}
          busy={busy}
          onBusy={setBusy}
          onBack={() => {
            setStep({ step: 'lines', sale: step.sale });
          }}
          onDone={onDone}
          onExchange={onExchange}
        />
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// 1. The receipt's number

function FindStep({
  copy,
  register,
  today,
  canReturn,
  stopped,
  onFound,
}: {
  copy: LocalCopy;
  register: SyncPosRegister;
  today: string;
  canReturn: boolean;
  stopped: string | null;
  onFound: (sale: PosReturnableSale) => void;
}) {
  const { t, format } = useLocale();
  const online = useOnline();
  const [number, setNumber] = useState('');
  // An error code: FormAlert says it in the page's language
  const [error, setError] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const open = canReturn && stopped === null;

  const find = async () => {
    // Like the route: "pos1-000164" is POS1-000164
    const typed = number.trim().toUpperCase();
    if (typed === '') return;
    setFinding(true);
    setError(null);
    try {
      const sale = await findSale(copy, typed, online);
      if (!sale) {
        setError('pos_return_sale_not_found');
        return;
      }
      const problem = saleProblem(sale, today, register);
      if (problem) {
        setError(problem);
        return;
      }
      onFound(sale);
    } catch (failure) {
      setError(failure instanceof ApiRequestError ? failure.code : 'unknown_error');
    } finally {
      setFinding(false);
    }
  };

  return (
    <DialogContent
      title={t('pos.return.title')}
      description={t('pos.return.description')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="pos-return-find" disabled={!open || finding}>
            {finding ? t('pos.return.finding') : t('pos.return.find')}
          </Button>
        </>
      }
    >
      {!canReturn ? (
        <DocumentNotice tone="neutral">{t('pos.return.cantReturn')}</DocumentNotice>
      ) : stopped !== null ? (
        <DocumentNotice tone="warn">{stopped}</DocumentNotice>
      ) : (
        <form
          id="pos-return-find"
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!finding) void find();
          }}
        >
          {error && <FormAlert message={error} />}
          <label className="grid gap-1.5">
            <span className="text-label font-medium">{t('pos.return.number')}</span>
            <Input
              // A scanner reads the receipt's barcode into it, like the search box
              icon={BarCode01Icon}
              autoFocus
              autoComplete="off"
              placeholder={t('pos.return.numberPlaceholder')}
              value={number}
              onChange={(event) => {
                setNumber(event.target.value);
                setError(null);
              }}
            />
          </label>
          {!online && (
            <DocumentNotice tone="neutral" icon={WifiDisconnected02Icon}>
              {t('pos.return.offlineHint', {
                code: register.code,
                days: format.number(POS_SALES_ON_DEVICE_DAYS),
              })}
            </DocumentNotice>
          )}
        </form>
      )}
    </DialogContent>
  );
}

// ---------------------------------------------------------------------------------------------
// 2. What came back

function LinesStep({
  sale,
  register,
  timeZone,
  unitOf,
  picks,
  onPicks,
  note,
  onNote,
  onNext,
}: {
  sale: PosReturnableSale;
  register: SyncPosRegister;
  timeZone: string;
  unitOf: UnitOf;
  picks: ReturnPicks;
  onPicks: (picks: ReturnPicks) => void;
  note: string;
  onNote: (note: string) => void;
  onNext: (lines: PosReturnLineInput[]) => void;
}) {
  const { t, format } = useLocale();
  const lines = returnLinesOf(sale, picks);
  const total = returnTotalOf(lines);
  const problem = picksProblem(sale, picks);
  const lastDay = parseIsoDate(lastReturnDayOf(sale.date, register.returnDays));
  const description = [
    t('pos.return.soldAt', { time: format.dateTime(new Date(sale.soldAt), timeZone) }),
    lastDay ? t('pos.return.lastDay', { date: format.date(lastDay) }) : '',
  ]
    .filter((part) => part !== '')
    .join(' · ');

  const pick = (line: PosReturnableLine, next: ReturnPick | null) => {
    const others = Object.fromEntries(Object.entries(picks).filter(([id]) => id !== line.id));
    onPicks(next ? { ...others, [line.id]: next } : others);
  };

  return (
    <DialogContent
      title={t('pos.return.saleTitle', { number: sale.number })}
      description={description}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            type="submit"
            form="pos-return-lines"
            // A return of ৳0 (a free sample) still needs a line; the amount may be nothing
            disabled={problem !== null}
          >
            {t('pos.return.next', { amount: screenMoney(format, total) })}
          </Button>
        </>
      }
    >
      <form
        id="pos-return-lines"
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (problem === null) onNext(lines);
        }}
      >
        <ul className="divide-y divide-line overflow-hidden rounded-control border border-line">
          {sale.lines.map((line) => (
            <ReturnLineRow
              key={line.id}
              line={line}
              unitOf={unitOf}
              pick={picks[line.id] ?? null}
              onPick={(next) => {
                pick(line, next);
              }}
              tooLarge={problem?.line === line.id}
            />
          ))}
        </ul>
        <label className="grid gap-1.5">
          <span className="text-label font-medium">
            {t('pos.return.note')}{' '}
            <span className="font-normal text-ink-3">{t('common.optional')}</span>
          </span>
          <Input
            maxLength={200}
            placeholder={t('pos.return.notePlaceholder')}
            value={note}
            onChange={(event) => {
              onNote(event.target.value);
            }}
          />
        </label>
        <div className="flex items-baseline justify-between gap-3 rounded-control bg-subtle px-4 py-3">
          <span className="text-body-sm font-medium">{t('pos.return.total')}</span>
          <span className="text-kpi font-semibold tracking-[-0.03em] tabular-nums">
            {screenMoney(format, total)}
          </span>
        </div>
      </form>
    </DialogContent>
  );
}

function ReturnLineRow({
  line,
  unitOf,
  pick,
  onPick,
  tooLarge,
}: {
  line: PosReturnableLine;
  unitOf: UnitOf;
  pick: ReturnPick | null;
  onPick: (pick: ReturnPick | null) => void;
  tooLarge: boolean;
}) {
  const { t, format, errorText } = useLocale();
  const unit = unitOf(line.unitId);
  const decimals = unit?.decimals ?? 0;
  const code = unit?.code ?? '';
  const left = returnableQuantityOf(line);
  const id = `pos-return-${line.id}`;

  if (!hasLeft(line)) {
    return (
      <li className="flex items-start gap-2.5 bg-subtle px-3.5 py-3">
        <Checkbox
          id={id}
          label={t('pos.return.take', { name: line.description })}
          hideLabel
          disabled
        />
        <span className="grid">
          <span className="text-body-sm text-ink-2">{line.description}</span>
          <span className="text-caption text-ink-3">{t('pos.return.allBack')}</span>
        </span>
      </li>
    );
  }

  const amount = pick && returnLineOf(line, pick);
  const step = (by: number) => {
    if (!pick) return;
    const now = isQuantity(pick.quantity) ? pick.quantity : '0';
    const next = by > 0 ? addQuantity(now, '1') : subtractQuantity(now, '1');
    // Never below one, never above what is left: the arrows keep the box sensible
    if (compareQuantity(next, '1') < 0 || compareQuantity(next, left) > 0) return;
    onPick({ ...pick, quantity: plainQuantity(next) });
  };

  return (
    <li className="grid gap-2.5 px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <Checkbox
          id={id}
          label={t('pos.return.take', { name: line.description })}
          hideLabel
          checked={pick !== null}
          onCheckedChange={(checked) => {
            onPick(checked === true ? firstPick(line) : null);
          }}
        />
        <label htmlFor={id} className="grid min-w-0 flex-1">
          <span className="text-body-sm font-medium">{line.description}</span>
          <span className="text-caption text-ink-3 tabular-nums">
            {t('pos.return.left', {
              left: format.number(left, decimals),
              sold: `${format.number(line.quantity, decimals)} ${code}`,
            })}{' '}
            · × {screenMoney(format, line.unitPrice)}
          </span>
        </label>
        {amount && (
          <span className="text-body-sm font-medium whitespace-nowrap tabular-nums">
            {t('pos.return.lineBack', {
              amount: screenMoney(format, sumMoney([amount.net, amount.vat])),
            })}
          </span>
        )}
      </div>
      {pick && line.tracking !== 'serial' && (
        <div className="flex flex-wrap items-center gap-2.5 pl-[27px]">
          <label htmlFor={`${id}-quantity`} className="text-label font-medium text-ink-2">
            {t('pos.return.quantity')}
          </label>
          <span className="inline-flex items-center rounded-control border border-line-strong bg-surface">
            <button
              type="button"
              aria-label={`${t('pos.return.quantity')} −1`}
              onClick={() => {
                step(-1);
              }}
              className="grid size-8 place-items-center text-ink-2 hover:text-ink"
            >
              <HugeiconsIcon icon={MinusSignIcon} size={14} strokeWidth={1.5} />
            </button>
            <input
              id={`${id}-quantity`}
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={tooLarge}
              value={pick.quantity}
              onChange={(event) => {
                onPick({ ...pick, quantity: event.target.value });
              }}
              className="w-14 bg-transparent text-center text-body-sm font-medium tabular-nums outline-none"
            />
            <button
              type="button"
              aria-label={`${t('pos.return.quantity')} +1`}
              onClick={() => {
                step(1);
              }}
              className="grid size-8 place-items-center text-ink-2 hover:text-ink"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.5} />
            </button>
          </span>
          <span className="text-label text-ink-3">{code}</span>
          {tooLarge && (
            <span className="w-full text-label text-crit">
              {errorText('pos_return_quantity_too_large')}
            </span>
          )}
        </div>
      )}
      {pick && line.tracking === 'serial' && (
        <div className="pl-[27px]">
          <CheckboxGroup
            legend={t('pos.return.serials')}
            options={serialsLeft(line).map((serial) => ({
              value: serial,
              label: <span className="font-mono">{serial}</span>,
            }))}
            value={pick.serials}
            onChange={(serials) => {
              onPick({ ...pick, serials });
            }}
            hint={t('pos.return.serialsHint')}
          />
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// 3. The money back

function RefundStep({
  copy,
  register,
  shift,
  today,
  cashier,
  sale,
  lines,
  note,
  unitOf,
  busy,
  onBusy,
  onBack,
  onDone,
  onExchange,
}: {
  copy: LocalCopy;
  register: SyncPosRegister;
  shift: DeviceShift;
  today: string;
  cashier: string;
  sale: PosReturnableSale;
  lines: PosReturnLineInput[];
  note: string;
  unitOf: UnitOf;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onBack: () => void;
  onDone: (done: DoneReturn) => void;
  onExchange: (exchange: PosCartExchange) => void;
}) {
  const { t, format } = useLocale();
  const total = returnTotalOf(lines);
  const free = isZeroMoney(total);
  const methods = refundMethodsAt(register, sale);
  const [rows, setRows] = useState<PaymentRow[]>(() => (free ? [] : [refundRow('cash', total)]));
  const [error, setError] = useState<string | null>(null);
  const amountOf = (value: string) => (isMoneyAmount(value) ? value : '0');
  const given = sumMoney(rows.map((row) => amountOf(row.amount)));
  const due = dueOf(rows, total);

  const complete = async () => {
    setError(null);
    const returnedAt = new Date().toISOString();
    const parsed = posReturnInputSchema.safeParse({
      registerId: register.id,
      // Only for the check: the save gives the return its number (savePosReturn)
      sequence: 1,
      shiftId: shift.id,
      date: today,
      returnedAt,
      saleId: sale.id,
      lines,
      refunds: refundValues(rows),
      note,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'unknown_error');
      return;
    }
    // The sequence was only for the check: the save gives the return its number
    const input = parsed.data;
    onBusy(true);
    try {
      const result = await savePosReturn(copy, {
        returnId: newReturnId(),
        input,
        registerCode: register.code,
        savedAt: returnedAt,
      });
      if (result.kind === 'not-held') {
        setError('pos_register_not_held');
        return;
      }
      if (result.kind === 'no-shift') {
        setError('pos_shift_closed');
        return;
      }
      requestSync();
      onDone({
        number: result.number,
        slip: returnSlipOf({
          number: result.number,
          returnedAt,
          register,
          cashier,
          sale,
          lines: input.lines,
          refunds: input.refunds,
          usedOn: null,
          note: input.note,
          unitOf,
        }),
      });
    } catch {
      setError(t('sync.saveFailed'));
    } finally {
      onBusy(false);
    }
  };

  return (
    <DialogContent
      title={t('pos.return.refundTitle')}
      description={t('pos.return.refundDescription', { total: screenMoney(format, total) })}
      footer={
        <>
          <Button variant="secondary" className="mr-auto" disabled={busy} onClick={onBack}>
            {t('pos.return.back')}
          </Button>
          <Button type="submit" form="pos-return-refund" disabled={busy} className="gap-2">
            {busy ? t('pos.return.completing') : t('pos.return.complete')}
            <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <form
        id="pos-return-refund"
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void complete();
        }}
      >
        {error && <FormAlert message={error} />}
        {!free && <RefundRows rows={rows} onRows={setRows} methods={methods} total={total} />}
        <dl className="grid gap-1.5 rounded-control bg-subtle px-4 py-3 text-body-sm tabular-nums">
          <div className="flex justify-between gap-3 text-ink-2">
            <dt>{t('pos.return.due')}</dt>
            <dd>{screenMoney(format, due)}</dd>
          </div>
          <div className="flex justify-between gap-3 font-medium">
            <dt>{t('pos.return.given')}</dt>
            <dd>{screenMoney(format, given)}</dd>
          </div>
        </dl>
        {/* Decision 1: the other way out. Only at a register with an exchange account (decision 6),
            and only for money: a free sample has nothing to spend */}
        {register.exchangeAccountId === null ? (
          <p className="text-label text-ink-3">
            {t('pos.return.noExchange', { code: register.code })}
          </p>
        ) : (
          !free && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onExchange({
                  returnId: newReturnId(),
                  sale,
                  lines,
                  note: note.trim() === '' ? null : note.trim(),
                  total,
                });
              }}
              className="flex items-center gap-3 rounded-control border border-line-strong bg-surface px-3.5 py-3 text-left shadow-sm transition-colors duration-150 hover:bg-subtle"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
                <HugeiconsIcon icon={ArrowLeftRightIcon} size={17} strokeWidth={1.5} />
              </span>
              <span className="grid flex-1">
                <span className="text-body-sm font-medium">{t('pos.return.exchange')}</span>
                <span className="text-caption text-ink-3">{t('pos.return.exchangeHint')}</span>
              </span>
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                size={16}
                strokeWidth={1.5}
                className="text-ink-3"
              />
            </button>
          )
        )}
      </form>
    </DialogContent>
  );
}

// ---------------------------------------------------------------------------------------------
// After the return

// What the cashier hands over, big, like the sale's change: the cash, and a line for each other
// way the money goes back ("Send ৳500 back by bKash"). The slip has gone to the printer already.
export function ReturnDoneDialog({
  done,
  offline,
  onPrint,
  onNew,
}: {
  done: DoneReturn;
  offline: boolean;
  onPrint: () => void;
  onNew: () => void;
}) {
  const { t, format } = useLocale();
  const { refunds } = done.slip;
  const cash = sumMoney(
    refunds.filter((refund) => refund.method === 'cash').map((refund) => refund.amount),
  );
  const others = refunds.filter((refund) => refund.method !== 'cash');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onNew();
      }}
    >
      <DialogContent
        title={t('pos.return.doneTitle', { number: done.number })}
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
            className={
              isZeroMoney(cash) ? 'text-body text-ink-2' : 'text-kpi font-semibold tabular-nums'
            }
          >
            {isZeroMoney(cash)
              ? t('pos.return.noCash')
              : t('pos.return.giveCash', { amount: screenMoney(format, cash) })}
          </p>
          {others.map((refund, index) => (
            <p key={`${String(index)}-${refund.method}`} className="text-body-sm text-ink-2">
              {t('pos.return.giveOther', {
                amount: screenMoney(format, refund.amount),
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

// The cart's "Drop the exchange" asks first (the mockup's open point 3): the return goes back to
// paying the money back, and the new cart is cleared
export function DropExchangeDialog({
  onClose,
  onDrop,
}: {
  onClose: () => void;
  onDrop: () => void;
}) {
  const { t } = useLocale();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        title={t('pos.exchange.dropTitle')}
        description={t('pos.exchange.dropHint')}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">{t('pos.exchange.keep')}</Button>
            </DialogClose>
            <Button autoFocus onClick={onDrop}>
              {t('pos.exchange.drop')}
            </Button>
          </>
        }
      >
        {null}
      </DialogContent>
    </Dialog>
  );
}
