import { AlertCircleIcon, MinusSignCircleIcon, PrinterIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CashCount,
  CASH_DENOMINATIONS,
  compareMoney,
  contractErrorMap,
  type EntryRef,
  multiplyMoney,
  type PosRegister,
  type PosShift,
  type PosShiftReport,
  posShiftCloseWithoutCountInputSchema,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  KpiStrip,
  PageHeader,
  TextAreaField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Fact } from '../components/adjustment-view';
import { DocumentNotice } from '../components/document-notice';
import { EntryLinks } from '../components/entry-links';
import { failureOf } from '../components/journal-parts';
import { useReceiptCompany } from '../components/pos-parts';
import { counterMoney, differenceWords, PosShiftPill } from '../components/pos-shift-parts';
import { SalesBackLink } from '../components/sales-parts';
import { useIsoDate, useTenantId, useTimeZone } from '../components/stock-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { posRegisterQuery, posShiftQuery } from '../lib/pos-queries';
import { zReportOf } from '../lib/pos-shift';
import { settingsQuery } from '../lib/queries';
import { useOnline } from '../lib/use-online';

// Step 20b: one shift, as the server has it (pos.shift.manage): the two counts, what the drawer
// should hold and why, what the sales took by each method, the pay ins and outs, and the journal
// entries. An open shift that nobody can close is closed here without a count (decisions 11, 27).
// Every amount has its paisa, like a document; the three numbers at the top read like the
// counter's result (whole taka unless there is paisa), so a manager compares them at a glance.
// Step 20c: what the returns paid back, the Z report's sums, a link to the shift's returns, and
// "Print Z report" for a closed shift (decision 4), on the register's receipt printer.

const PosShiftReportSheet = lazy(async () => ({
  default: (await import('../components/pos-receipt')).PosShiftReportSheet,
}));

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/pos/shifts" label={t('posShifts.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('posShifts.title')} description={message} />
    </div>
  );
}

export function PosShiftPage() {
  const { t } = useLocale();
  const online = useOnline();
  const { shiftId = '' } = useParams({ strict: false });
  const { data: shift, isError } = useQuery({
    ...posShiftQuery(useTenantId(), shiftId),
    enabled: shiftId !== '',
  });
  if (isError) return <CantFind message={t('posShifts.notFound')} />;
  // Offline before it ever loaded: the shifts are read from the server only
  if (!shift) return online ? null : <CantFind message={t('posShifts.needsConnection')} />;
  return <PosShiftView shift={shift} />;
}

function PosShiftView({ shift }: { shift: PosShift }) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const isoDate = useIsoDate();
  const [closing, setClosing] = useState(false);
  const [printing, setPrinting] = useState(false);
  // The Z report prints on the register's paper, with the company's header
  const register = useQuery(posRegisterQuery(tenantId, shift.register.id)).data;
  const settings = useQuery(settingsQuery(tenantId)).data;
  const money = (value: string) => format.money(value, { decimals: 2 });
  const time = (iso: string) => format.dateTime(new Date(iso), timeZone);
  // Decision 22: the books use the server's number; the page says when the device's differed
  const differs =
    shift.closing !== null && compareMoney(shift.closing.deviceExpected, shift.expectedCash) !== 0;
  // The opening's entry is the float on a register's first shift, else the opening difference
  const openingEntryLabel =
    shift.opening.floatReason === null
      ? t('posShifts.entries.opening')
      : t('posShifts.entries.float');

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/pos/shifts" label={t('posShifts.back')} />
      <PageHeader
        title={shift.number}
        description={`${shift.register.code} · ${shift.register.name}`}
        actions={
          <>
            <PosShiftPill status={shift.status} />
            {/* Only after the close: an open shift's sums still change (its X report is the
                counter's, from the device) */}
            {shift.status !== 'open' && register && settings && (
              <Button
                variant="secondary"
                className="gap-1.5"
                disabled={printing}
                onClick={() => {
                  setPrinting(true);
                }}
              >
                <HugeiconsIcon icon={PrinterIcon} size={17} strokeWidth={1.5} />
                {t('posShifts.printZ')}
              </Button>
            )}
            {shift.status === 'open' && (
              <Button
                variant="secondary"
                onClick={() => {
                  setClosing(true);
                }}
              >
                <HugeiconsIcon icon={MinusSignCircleIcon} size={17} strokeWidth={1.5} />
                {t('posShifts.closeWithoutCount')}
              </Button>
            )}
          </>
        }
      />
      {shift.status === 'open' && (
        <DocumentNotice tone="neutral">
          {t('posShifts.stillOpen', { time: time(shift.openedAt) })}
        </DocumentNotice>
      )}
      {shift.status === 'closed_without_count' && (
        <DocumentNotice tone="neutral">
          {t('posShifts.withoutCount')}
          {shift.closedBy && shift.closedAt !== null && (
            <span className="block text-ink-3">
              {t('posShifts.closedBy', {
                name: shift.closedBy.fullName,
                time: time(shift.closedAt),
              })}
            </span>
          )}
        </DocumentNotice>
      )}
      {differs && shift.closing && (
        <DocumentNotice tone="neutral">
          {t('posShifts.expectedDiffers', {
            device: money(shift.closing.deviceExpected),
            server: money(shift.expectedCash),
          })}
        </DocumentNotice>
      )}
      <KpiStrip
        cells={[
          {
            label: t('posShifts.columns.expected'),
            value: counterMoney(format, shift.expectedCash),
          },
          {
            label: t('posShifts.columns.counted'),
            value: shift.countedCash === null ? '—' : counterMoney(format, shift.countedCash),
          },
          {
            label: t('posShifts.columns.difference'),
            value: shift.difference === null ? '—' : differenceWords(t, format, shift.difference),
          },
        ]}
      />
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <Fact
          label={t('posShifts.register')}
          value={`${shift.register.code} · ${shift.register.name}`}
        />
        <Fact label={t('posShifts.cashier')} value={shift.cashier.fullName} />
        <Fact label={t('posShifts.device')} value={shift.device.name} />
        <Fact label={t('posShifts.openedAt')} value={time(shift.openedAt)} />
        <Fact
          label={t('posShifts.closedAt')}
          value={shift.closedAt === null ? '—' : time(shift.closedAt)}
        />
      </Card>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-3">
        <CashCard shift={shift} money={money} />
        <Card>
          {/* The sales the server has received in the shift, and what they took by method */}
          <CardHeader
            title={t('posShifts.payments')}
            subtitle={t('posShifts.sales', {
              count: shift.saleCount,
              formatted: format.number(shift.saleCount),
              total: money(shift.salesTotal),
            })}
          />
          <dl className="grid gap-2 px-5 pt-3 pb-5 text-body-sm">
            {shift.payments.map((payment) => (
              <Row
                key={payment.method}
                label={t(`pos.methods.${payment.method}`)}
                value={money(payment.amount)}
              />
            ))}
            {/* Step 20c: the Z report's two sums of the sales, under a rule: they are not money
                taken, they are inside the total above */}
            <div className="grid gap-2 border-t border-line pt-2">
              <Row label={t('posShifts.salesDiscount')} value={money(shift.salesDiscount)} />
              <Row label={t('posShifts.salesVat')} value={money(shift.salesVat)} />
            </div>
          </dl>
        </Card>
        <RefundsCard shift={shift} money={money} />
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('posShifts.opening')} />
          <div className="grid gap-4 px-5 pt-3 pb-5">
            <dl className="grid gap-2 text-body-sm">
              <Row label={t('posShifts.openingCounted')} value={money(shift.opening.count.total)} />
              {shift.opening.comparedWith === null ? (
                <p className="text-ink-3">{t('posShifts.firstShift')}</p>
              ) : (
                <Row label={t('posShifts.lastLeft')} value={money(shift.opening.comparedWith)} />
              )}
              {shift.opening.difference !== null && (
                <Row
                  label={t('posShifts.columns.difference')}
                  value={differenceWords(t, format, shift.opening.difference)}
                />
              )}
              {shift.opening.floatReason && (
                <Row label={t('posShifts.floatReason')} value={shift.opening.floatReason.name} />
              )}
            </dl>
            <CountTable count={shift.opening.count} money={money} />
          </div>
        </Card>
        {shift.closing && (
          <Card>
            <CardHeader title={t('posShifts.closing')} />
            <div className="grid gap-4 px-5 pt-3 pb-5">
              <dl className="grid gap-2 text-body-sm">
                <Row
                  label={t('posShifts.columns.counted')}
                  value={money(shift.closing.count.total)}
                />
                <Row
                  label={t('posShifts.deviceExpected')}
                  value={money(shift.closing.deviceExpected)}
                />
                <Row
                  label={t('posShifts.heldDropped')}
                  value={format.number(shift.closing.heldDropped)}
                />
              </dl>
              <CountTable count={shift.closing.count} money={money} />
            </div>
          </Card>
        )}
      </div>
      <MovementsCard shift={shift} money={money} time={time} isoDate={isoDate} />
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-2">
        <EntryLinks
          label={openingEntryLabel}
          entries={shift.opening.entry ? [shift.opening.entry] : []}
          none="—"
        />
        <EntryLinks
          label={t('posShifts.entries.closing')}
          entries={shift.closing?.entry ? [shift.closing.entry] : []}
          none="—"
        />
      </Card>
      {printing && register && settings && (
        <Suspense fallback={null}>
          <ZReport
            shift={shift}
            register={register}
            settings={settings}
            onPrinted={() => {
              setPrinting(false);
            }}
          />
        </Suspense>
      )}
      {closing && (
        <CloseWithoutCountDialog
          shift={shift}
          onClose={() => {
            setClosing(false);
          }}
        />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-2">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </div>
  );
}

// Why the drawer should hold what it does: expectedCashOf()'s parts, then the sum. Change, pay outs
// and (step 20c) the cash paid back take money away, so they have a minus.
function CashCard({ shift, money }: { shift: PosShift; money: (value: string) => string }) {
  const { t } = useLocale();
  const { cash } = shift;
  return (
    <Card>
      <CardHeader title={t('posShifts.cash.title')} />
      <dl className="grid gap-2 px-5 pt-3 pb-5 text-body-sm">
        <Row label={t('posShifts.cash.opening')} value={money(cash.opening)} />
        <Row label={t('posShifts.cash.cashTaken')} value={money(cash.cashTaken)} />
        <Row label={t('posShifts.cash.changeGiven')} value={`−${money(cash.changeGiven)}`} />
        <Row label={t('posShifts.cash.paidIn')} value={money(cash.paidIn)} />
        <Row label={t('posShifts.cash.paidOut')} value={`−${money(cash.paidOut)}`} />
        <Row label={t('posShifts.cash.cashRefunded')} value={`−${money(cash.cashRefunded)}`} />
        <div className="flex justify-between gap-3 border-t border-line pt-2 font-medium">
          <dt>{t('posShifts.cash.expected')}</dt>
          <dd className="tabular-nums">{money(shift.expectedCash)}</dd>
        </div>
      </dl>
    </Card>
  );
}

// Step 20c (decision 27): what the returns taken back in the shift paid back, by tender: cash (in
// the drawer's sum above), the register's other methods, and an exchange when one was used. The
// returns' VAT for the Z report, and a link to the returns themselves when there are any.
function RefundsCard({ shift, money }: { shift: PosShift; money: (value: string) => string }) {
  const { t, format } = useLocale();
  return (
    <Card>
      <CardHeader
        title={t('posShifts.refunds')}
        subtitle={t('posShifts.returns', {
          count: shift.returnCount,
          formatted: format.number(shift.returnCount),
          total: money(shift.returnsTotal),
        })}
      />
      <dl className="grid gap-2 px-5 pt-3 pb-5 text-body-sm">
        {shift.refunds.map((refund) => (
          <Row
            key={refund.method}
            label={t(`pos.methods.${refund.method}`)}
            value={money(refund.amount)}
          />
        ))}
        <div className="grid gap-2 border-t border-line pt-2">
          <Row label={t('posShifts.returnsVat')} value={money(shift.returnsVat)} />
        </div>
        {shift.returnCount > 0 && (
          <Link
            to="/pos/returns"
            search={{ shiftId: shift.id }}
            className="w-fit font-medium text-brand underline-offset-3 hover:underline"
          >
            {t('posShifts.seeReturns')}
          </Link>
        )}
      </dl>
    </Card>
  );
}

// The Z report, made once when asked (useState's first value), so the paper does not change while
// the print dialog is open; it leaves the page once printed (onPrinted), like the counter's.
function ZReport({
  shift,
  register,
  settings,
  onPrinted,
}: {
  shift: PosShift;
  register: PosRegister;
  settings: Parameters<typeof useReceiptCompany>[0];
  onPrinted: () => void;
}) {
  const company = useReceiptCompany(settings);
  const [report] = useState<PosShiftReport>(() => zReportOf(shift, new Date().toISOString()));
  return (
    <PosShiftReportSheet
      report={report}
      paperWidth={register.paperWidth}
      company={company}
      onPrinted={onPrinted}
    />
  );
}

// A count by notes as the cashier typed it (only the notes there were), or one line for a count
// typed as a total
function CountTable({ count, money }: { count: CashCount; money: (value: string) => string }) {
  const { t, format } = useLocale();
  const { notes } = count;
  if (notes === null) return <p className="text-body-sm text-ink-3">{t('posShifts.asTotal')}</p>;
  const rows = CASH_DENOMINATIONS.filter((note) => notes[note] > 0);
  return (
    <div className="overflow-x-auto rounded-control border border-line">
      <table className="w-full border-collapse text-body-sm">
        <thead className="bg-subtle text-caption font-medium text-ink-3">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {t('posShifts.countColumns.note')}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t('posShifts.countColumns.count')}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t('posShifts.countColumns.amount')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((note) => (
            <tr key={note} className="border-t border-line">
              <td className="px-3 py-2 tabular-nums">{format.money(note, { decimals: 0 })}</td>
              <td className="px-3 py-2 text-right tabular-nums">{format.number(notes[note])}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {money(multiplyMoney(String(notes[note]), note))}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line bg-subtle font-medium">
            <td className="px-3 py-2" colSpan={2}>
              {t('posShifts.columns.counted')}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{money(count.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// The pay ins and pay outs, in the order they happened on the device (decision 63's note: by
// movedAt). Each has its own entry.
function MovementsCard({
  shift,
  money,
  time,
  isoDate,
}: {
  shift: PosShift;
  money: (value: string) => string;
  time: (iso: string) => string;
  isoDate: (iso: string) => string;
}) {
  const { t } = useLocale();
  return (
    <Card>
      <CardHeader title={t('posShifts.movements')} />
      {shift.movements.length === 0 ? (
        <p className="px-5 pt-3 pb-5 text-body-sm text-ink-3">{t('posShifts.noMovements')}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[44rem] border-collapse text-body-sm">
            <thead className="bg-subtle text-left text-caption font-medium text-ink-3">
              <tr>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  {t('posShifts.movementColumns.time')}
                </th>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  {t('posShifts.movementColumns.reason')}
                </th>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  {t('posShifts.movementColumns.direction')}
                </th>
                <th scope="col" className="px-5 py-2.5 text-right font-medium">
                  {t('posShifts.movementColumns.amount')}
                </th>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  {t('posShifts.movementColumns.note')}
                </th>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  {t('posShifts.movementColumns.entry')}
                </th>
              </tr>
            </thead>
            <tbody>
              {shift.movements.map((movement) => (
                <tr key={movement.id} className="border-t border-line">
                  <td className="px-5 py-3 tabular-nums">
                    {time(movement.movedAt)}
                    {/* The day in the books, when a closed day moved it (like a sale's) */}
                    <span className="block text-caption text-ink-3">{isoDate(movement.date)}</span>
                  </td>
                  <td className="px-5 py-3">{movement.reason.name}</td>
                  <td className="px-5 py-3 text-ink-2">
                    {t(`posShifts.directions.${movement.direction}`)}
                  </td>
                  <td className="px-5 py-3 text-right font-medium tabular-nums">
                    {movement.direction === 'out' ? '−' : ''}
                    {money(movement.amount)}
                  </td>
                  <td className="max-w-[16rem] px-5 py-3 text-ink-2">{movement.note ?? '—'}</td>
                  <td className="px-5 py-3">
                    <EntryLink entry={movement.entry} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// A movement's entry in its table cell: a link for someone who reads the journal, the plain
// number for everyone else, like EntryLinks (which is a fact cell, with its own label)
function EntryLink({ entry }: { entry: EntryRef }) {
  const canRead = useCan()('accounting.journal.read');
  return canRead ? (
    <Link
      to="/journal/$entryId"
      params={{ entryId: entry.id }}
      className="font-mono font-medium text-brand tabular-nums underline-offset-3 hover:underline"
    >
      {entry.number}
    </Link>
  ) : (
    <span className="font-mono tabular-nums">{entry.number}</span>
  );
}

// The one box the server may name in fieldErrors (a note over 200 characters)
const FIELD_NAMES = ['note'] as const;

// Decisions 11 and 27: for a shift its cashier can't close. The note is for the audit log. The
// server answers with the closed shift, which takes the page's place at once.
function CloseWithoutCountDialog({ shift, onClose }: { shift: PosShift; onClose: () => void }) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(posShiftCloseWithoutCountInputSchema, { error: contractErrorMap }),
    defaultValues: { note: '' },
  });
  const close = useMutation({
    mutationFn: (note: string | null) =>
      call(routes.posShifts.closeWithoutCount, { params: { id: shift.id }, body: { note } }),
  });

  const failure = errors.root?.server?.message ?? failureOf(close.error);

  const onSubmit = handleSubmit(async ({ note }) => {
    try {
      const saved = await close.mutateAsync(note);
      queryClient.setQueryData(posShiftQuery(tenantId, shift.id).queryKey, saved);
      // The list, and the register's row (its holder and last shift)
      await queryClient.invalidateQueries({ queryKey: ['pos', tenantId] });
      toast(t('posShifts.closedToast', { number: saved.number }));
      onClose();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        title={t('posShifts.closeTitle', { number: shift.number })}
        description={t('posShifts.closeBody')}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">{t('common.cancel')}</Button>
            </DialogClose>
            <Button type="submit" form="close-without-count" disabled={isSubmitting}>
              {t('posShifts.closeConfirm')}
            </Button>
          </>
        }
      >
        <form
          id="close-without-count"
          noValidate
          onSubmit={(event) => void onSubmit(event)}
          className="grid gap-5"
        >
          {/* pos_shift_closed (its cashier closed it meanwhile), version and network errors */}
          {failure && <FormAlert message={failure} />}
          <TextAreaField
            label={t('posShifts.closeNote')}
            optional
            placeholder={t('posShifts.closeNotePlaceholder')}
            {...register('note')}
            error={errors.note?.message}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
