import { CheckmarkCircle02Icon, Coins01Icon, PrinterIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  CASH_DENOMINATIONS,
  cashCountSchema,
  cashDifferenceOf,
  contractErrorMap,
  isMoneyAmount,
  isZeroMoney,
  posCashMovementInputSchema,
  type PosCashDirection,
  type SyncPosCashReason,
  type SyncPosRegister,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  closeShift,
  type DeviceShift,
  type LocalCopy,
  moveCash,
  openShift,
  type ShiftCloseResult,
  type ShiftStart,
} from '@omnivo/sync';
import {
  Button,
  Card,
  Dialog,
  DialogClose,
  DialogContent,
  Field,
  FormAlert,
  Input,
  KpiStrip,
  MoneyInput,
  SegmentedControl,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useId, useState } from 'react';

import { requestSync } from '../lib/local-data';
import {
  boxesTotal,
  type CountMode,
  countValues,
  differenceKind,
  EMPTY_NOTES,
  type NoteBoxes,
  noteAmount,
  noteDigits,
} from '../lib/pos-shift';
import { DocumentNotice } from './document-notice';
import { counterMoney, differenceWords } from './pos-shift-parts';

// Step 20b: the shift's screens on /pos, a chunk of their own (loaded the first time one shows,
// offline too: the service worker keeps it). The open card takes the selling screen's place until a
// shift is open; pay in, pay out and the close are dialogs over it; the result follows the close.

type Format = ReturnType<typeof useLocale>['format'];

// The first error the schema found, as a code (the Field and FormAlert say it in words)
function firstIssue(error: { issues: readonly { message: string }[] }): string {
  return error.issues[0]?.message ?? 'unknown_error';
}

// ---------------------------------------------------------------------------------------------
// The count (decision 8): by notes, or as one total. The same boxes at the open and at the close.

function useCashCount() {
  const [mode, setMode] = useState<CountMode>('notes');
  const [boxes, setBoxes] = useState<NoteBoxes>(EMPTY_NOTES);
  const [total, setTotal] = useState('');
  return {
    mode,
    setMode,
    boxes,
    setBox: (denomination: keyof NoteBoxes, value: string) => {
      setBoxes((current) => ({ ...current, [denomination]: noteDigits(value) }));
    },
    total,
    setTotal,
    values: () => countValues(mode, boxes, total),
  };
}

type CashCountState = ReturnType<typeof useCashCount>;

function CashCount({ count, error }: { count: CashCountState; error: string | undefined }) {
  const { t, format } = useLocale();
  const id = useId();
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        {/* Seen, not read: the control's own legend names it for a screen reader */}
        <span aria-hidden="true" className="text-label font-medium">
          {t('pos.shift.countBy')}
        </span>
        <SegmentedControl
          label={t('pos.shift.countBy')}
          value={count.mode}
          options={(['notes', 'total'] as const).map((mode) => ({
            value: mode,
            label: t(`pos.shift.countModes.${mode}`),
          }))}
          onChange={count.setMode}
        />
      </div>
      {count.mode === 'notes' ? (
        <fieldset className="grid gap-3">
          <legend className="mb-2 text-label font-medium">{t('pos.shift.notesLegend')}</legend>
          {/* Two columns from a tablet's width: ten boxes fit without a scroll */}
          <div className="grid gap-x-5 gap-y-2.5 sm:grid-cols-2">
            {CASH_DENOMINATIONS.map((denomination) => {
              const note = format.money(denomination);
              const box = count.boxes[denomination];
              return (
                <label
                  key={denomination}
                  className="grid grid-cols-[4.5rem_minmax(0,1fr)_6rem] items-center gap-3"
                >
                  <span className="text-body-sm font-medium tabular-nums">{note}</span>
                  <Input
                    aria-label={t('pos.shift.noteCount', { note })}
                    inputMode="numeric"
                    autoComplete="off"
                    align="end"
                    placeholder="0"
                    value={box}
                    onChange={(event) => {
                      count.setBox(denomination, event.target.value);
                    }}
                  />
                  <span className="text-right text-label text-ink-3 tabular-nums">
                    {box === ''
                      ? ''
                      : t('pos.shift.noteAmount', {
                          amount: format.money(noteAmount(denomination, box)),
                        })}
                  </span>
                </label>
              );
            })}
          </div>
          <p className="flex items-baseline justify-between rounded-control bg-subtle px-4 py-3">
            <span className="text-body-sm text-ink-2">{t('pos.shift.countTotal')}</span>
            <span className="text-h3 font-semibold tabular-nums">
              {format.money(boxesTotal(count.boxes))}
            </span>
          </p>
          {error && <FormAlert message={error} />}
        </fieldset>
      ) : (
        <Field id={`${id}-total`} label={t('pos.shift.countTotal')} error={error}>
          <MoneyInput
            id={`${id}-total`}
            autoFocus
            value={count.total}
            onChange={count.setTotal}
            invalid={error !== undefined}
          />
        </Field>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Opening

// The card in the selling screen's place (decision 1). The count is blind like the close's
// (decision 65): what the last shift left shows only in the toast after the open.
export function OpenShiftCard({
  copy,
  register,
  start,
  reasons,
  today,
}: {
  copy: LocalCopy;
  register: SyncPosRegister;
  start: ShiftStart;
  // The "in" reasons, for a first shift's float
  reasons: readonly SyncPosCashReason[];
  today: string;
}) {
  const { t, format } = useLocale();
  const count = useCashCount();
  const [floatReasonId, setFloatReasonId] = useState('');
  const [errors, setErrors] = useState<{ count?: string; floatReasonId?: string; form?: string }>(
    {},
  );
  const [saving, setSaving] = useState(false);
  const inReasons = reasons.filter((reason) => reason.direction === 'in');

  const submit = async () => {
    if (saving) return;
    const parsed = cashCountSchema.safeParse(count.values(), { error: contractErrorMap });
    if (!parsed.success) {
      setErrors({ count: firstIssue(parsed.error) });
      return;
    }
    const opening = parsed.data;
    // Decision 12: a first shift's float comes in from somewhere. The server never refuses it
    // (decision 25), so the device asks; an empty drawer needs no reason.
    if (start.first && !isZeroMoney(opening.total) && floatReasonId === '') {
      setErrors({ floatReasonId: 'pos_float_reason_required' });
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const result = await openShift(copy, {
        register,
        input: {
          date: today,
          openedAt: new Date().toISOString(),
          opening,
          floatReasonId: floatReasonId === '' ? null : floatReasonId,
        },
        savedAt: new Date().toISOString(),
      });
      if (result.kind === 'not-held') {
        setErrors({ form: 'pos_register_not_held' });
        return;
      }
      // open-already: another tab opened one, and this screen shows it at once (a live read). If
      // it does not, the open shift is another register's (a bug): it is closed first.
      if (result.kind === 'open-already') {
        setErrors({ form: 'pos_shift_still_open' });
        return;
      }
      requestSync();
      toast(openedText(t, format, result.shift, result.start));
    } catch {
      setErrors({ form: t('sync.saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mx-auto w-full max-w-[560px] p-[22px] sm:p-8">
      <form
        className="grid gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-1.5">
          <h1 className="text-h2 font-semibold tracking-[-0.02em] text-balance">
            {t('pos.shift.openTitle')}
          </h1>
          <p className="text-body-sm text-ink-2">{t('pos.shift.openDescription')}</p>
        </div>
        {errors.form && <FormAlert message={errors.form} />}
        <CashCount count={count} error={errors.count} />
        {start.first && (
          <div className="grid gap-4">
            <DocumentNotice tone="neutral">
              {t('pos.shift.firstShift', { code: register.code })}
            </DocumentNotice>
            {inReasons.length === 0 ? (
              <p className="text-label text-ink-3">{t('pos.shift.noInReasons')}</p>
            ) : (
              <SelectField
                label={t('pos.shift.floatReason')}
                options={[
                  { value: '', label: t('pos.shift.floatReasonPlaceholder') },
                  ...inReasons.map((reason) => ({ value: reason.id, label: reason.name })),
                ]}
                value={floatReasonId}
                onChange={(event) => {
                  setFloatReasonId(event.target.value);
                }}
                error={errors.floatReasonId}
              />
            )}
          </div>
        )}
        <Button type="submit" disabled={saving} className="w-full">
          {t('pos.shift.open')}
        </Button>
      </form>
    </Card>
  );
}

// The toast after the open: the shift's number, or what the last shift left and the difference.
// The device's own view (decision 63: the server compares with what it has, and books that).
function openedText(
  t: ReturnType<typeof useLocale>['t'],
  format: Format,
  shift: DeviceShift,
  start: ShiftStart,
): string {
  if (start.cashLeft === null) return t('pos.shift.opened', { number: shift.number });
  const difference = cashDifferenceOf(shift.opening.total, start.cashLeft);
  return differenceKind(difference) === 'even'
    ? t('pos.shift.openedEven', { amount: counterMoney(format, start.cashLeft) })
    : t('pos.shift.openedDifference', {
        expected: counterMoney(format, start.cashLeft),
        difference: differenceWords(t, format, difference),
      });
}

// ---------------------------------------------------------------------------------------------
// Pay in and pay out (decision 4)

export function CashMoveDialog({
  copy,
  shift,
  direction,
  reasons,
  today,
  onClose,
}: {
  copy: LocalCopy;
  shift: Pick<DeviceShift, 'id'>;
  direction: PosCashDirection;
  reasons: readonly SyncPosCashReason[];
  today: string;
  onClose: () => void;
}) {
  const { t, format } = useLocale();
  const id = useId();
  const choices = reasons.filter((reason) => reason.direction === direction);
  const [reasonId, setReasonId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ reasonId?: string; amount?: string; form?: string }>({});
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    const movedAt = new Date().toISOString();
    const parsed = posCashMovementInputSchema.safeParse(
      { shiftId: shift.id, reasonId, amount, note, date: today, movedAt },
      { error: contractErrorMap },
    );
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const [field] = issue.path;
        if (field === 'reasonId' || field === 'amount') next[field] ??= issue.message;
        else next.form ??= issue.message;
      }
      setErrors(next);
      return;
    }
    const reason = choices.find((one) => one.id === parsed.data.reasonId);
    if (!reason) {
      setErrors({ reasonId: 'pos_reason_required' });
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const done = t(`pos.cash.done.${direction}`, {
        amount: counterMoney(format, parsed.data.amount),
        reason: reason.name,
      });
      const result = await moveCash(copy, {
        input: parsed.data,
        direction,
        name: done,
        savedAt: movedAt,
      });
      switch (result.kind) {
        case 'too-large':
          setErrors({ amount: 'pos_pay_out_too_large' });
          return;
        case 'no-shift':
          setErrors({ form: 'pos_shift_closed' });
          return;
        case 'saved':
          requestSync();
          toast(done);
          onClose();
      }
    } catch {
      setErrors({ form: t('sync.saveFailed') });
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
        title={t(`pos.cash.titles.${direction}`)}
        description={t(`pos.cash.descriptions.${direction}`)}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={saving}>
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" form={`${id}-form`} disabled={saving || choices.length === 0}>
              {isMoneyAmount(amount) && !isZeroMoney(amount)
                ? t(`pos.cash.save.${direction}`, { amount: counterMoney(format, amount) })
                : t(`pos.cash.titles.${direction}`)}
            </Button>
          </>
        }
      >
        <form
          id={`${id}-form`}
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {errors.form && <FormAlert message={errors.form} />}
          {choices.length === 0 ? (
            <p className="text-body-sm text-ink-2">{t(`pos.cash.noReasons.${direction}`)}</p>
          ) : (
            <>
              <SelectField
                label={t('pos.cash.reason')}
                autoFocus
                options={[
                  { value: '', label: t('pos.cash.reasonPlaceholder') },
                  ...choices.map((reason) => ({ value: reason.id, label: reason.name })),
                ]}
                value={reasonId}
                onChange={(event) => {
                  setReasonId(event.target.value);
                }}
                error={errors.reasonId}
              />
              <Field id={`${id}-amount`} label={t('pos.cash.amount')} error={errors.amount}>
                <MoneyInput
                  id={`${id}-amount`}
                  value={amount}
                  onChange={setAmount}
                  invalid={errors.amount !== undefined}
                />
              </Field>
              <TextField
                label={t('pos.cash.note')}
                optional
                maxLength={200}
                placeholder={t('pos.cash.notePlaceholder')}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Closing (decisions 3 and 9): the count, then the result

export function CloseShiftDialog({
  copy,
  shift,
  held,
  today,
  onClose,
  onClosed,
}: {
  copy: LocalCopy;
  shift: Pick<DeviceShift, 'id' | 'number'>;
  // The held bills the close drops (the cart on the screen was held first, pos-screen.tsx)
  held: number;
  today: string;
  onClose: () => void;
  onClosed: (result: Extract<ShiftCloseResult, { kind: 'closed' }>) => void;
}) {
  const { t, format } = useLocale();
  const id = useId();
  const count = useCashCount();
  const [errors, setErrors] = useState<{ count?: string; form?: string }>({});
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    const parsed = cashCountSchema.safeParse(count.values(), { error: contractErrorMap });
    if (!parsed.success) {
      setErrors({ count: firstIssue(parsed.error) });
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const closedAt = new Date().toISOString();
      const result = await closeShift(copy, {
        shiftId: shift.id,
        input: { date: today, closedAt, counted: parsed.data },
        savedAt: closedAt,
      });
      if (result.kind === 'no-shift') {
        setErrors({ form: 'pos_shift_closed' });
        return;
      }
      requestSync();
      onClosed(result);
    } catch {
      setErrors({ form: t('sync.saveFailed') });
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
        title={t('pos.close.title', { number: shift.number })}
        description={t('pos.close.description')}
        footer={
          <>
            {/* The close is final: said where the button is, not only in a dialog nobody reads */}
            <p className="mr-auto self-center text-label text-ink-3">{t('pos.close.final')}</p>
            <DialogClose asChild>
              <Button variant="secondary" disabled={saving}>
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" form={`${id}-form`} disabled={saving}>
              {t('pos.close.confirm')}
            </Button>
          </>
        }
      >
        <form
          id={`${id}-form`}
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {errors.form && <FormAlert message={errors.form} />}
          <CashCount count={count} error={errors.count} />
          {held > 0 && (
            <DocumentNotice tone="neutral">
              {t('pos.close.heldDropped', { count: held, formatted: format.number(held) })}
            </DocumentNotice>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

// After the close: the count, what was expected and the difference, now that the count is in. The
// books get the difference when the close syncs (decision 5); a big one rings the managers' bell.
export function ShiftClosedDialog({
  result,
  onSignOut,
  onPrintZ,
  onNext,
}: {
  result: Extract<ShiftCloseResult, { kind: 'closed' }>;
  onSignOut: () => void;
  // Step 20c: the Z report on the receipt printer (decision 4), from the device's own shift
  onPrintZ: () => void;
  onNext: () => void;
}) {
  const { t, format } = useLocale();
  const { shift, difference } = result;
  const kind = differenceKind(difference);
  const amount = counterMoney(format, difference.replace(/^-/, ''));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onNext();
      }}
    >
      <DialogContent
        title={t('pos.close.doneTitle', { number: shift.number })}
        footer={
          <>
            <Button variant="secondary" className="mr-auto" onClick={onSignOut}>
              {t('common.signOut')}
            </Button>
            <Button variant="secondary" className="gap-1.5" onClick={onPrintZ}>
              <HugeiconsIcon icon={PrinterIcon} size={17} strokeWidth={1.5} />
              {t('pos.close.printZ')}
            </Button>
            <Button autoFocus onClick={onNext}>
              {t('pos.close.next')}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <span className="grid size-10 place-items-center rounded-lg bg-good-bg text-good">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={20} strokeWidth={1.5} />
          </span>
          <KpiStrip
            cells={[
              { label: t('pos.close.counted'), value: counterMoney(format, shift.counted ?? '0') },
              {
                label: t('pos.close.expected'),
                value: counterMoney(format, shift.expected ?? '0'),
              },
              { label: t('pos.close.difference'), value: differenceWords(t, format, difference) },
            ]}
          />
          {kind !== 'even' && (
            <DocumentNotice tone="warn" icon={Coins01Icon}>
              {t(`pos.close.${kind}`, { amount })}
            </DocumentNotice>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
