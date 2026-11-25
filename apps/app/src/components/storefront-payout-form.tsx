import {
  Alert02Icon,
  BankIcon,
  Calendar03Icon,
  CheckmarkCircle02Icon,
  FileImportIcon,
  InformationCircleIcon,
  Note01Icon,
  ShippingTruck01Icon,
  Tag01Icon,
  Wallet01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type PayoutAccount,
  type PayoutFormValues,
  type PayoutMatchRow,
  type PayoutParcel,
  type PayoutSetup,
  payoutInputSchema,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  cn,
  Dialog,
  EmptyState,
  FormAlert,
  FormField,
  Input,
  MoneyInput,
  PageHeader,
  Pill,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { Controller, type FieldErrors, type Path, useForm, useWatch } from 'react-hook-form';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import {
  applyMatch,
  type ChargeDrafts,
  fileDifference,
  orderLines,
  type PayoutLineValue,
  payoutTotals,
  startDrafts,
  storefrontPayoutParcelsQuery,
} from '../lib/storefront-payouts';
import { useTenantId } from '../lib/workspace';
import { DocumentNotice } from './document-notice';
import { ParcelPill } from './storefront-order-pills';
import { useIsoDate } from './stock-parts';
import { PayoutBackLink, usePayoutAccountName } from './storefront-payout-parts';
import { useShopMoney } from './storefront-parts';

// Step 28c: Record a courier payout (approved with the mockup, P3–P5 and P7). Its own chunk, loaded
// by routes/storefront-payout.tsx. A payout is never a draft: saving posts it, so this form is only
// for a new one. The form card (account, date, paid into, reference, note), then the Parcels card:
// every parcel of the account that no payout has taken, none ticked at first.

const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));
// The file dialog is its own chunk: most payouts are ticked by hand, and the CSV reading and the
// outcome list need not ride with the form
const PayoutFileDialog = lazy(async () => ({
  default: (await import('./storefront-payout-file')).PayoutFileDialog,
}));

type FormValues = PayoutFormValues;

function fieldNames(count: number): Path<FormValues>[] {
  return [
    'accountId',
    'date',
    'bankAccountId',
    'reference',
    'note',
    'lines',
    ...Array.from({ length: count }, (_, index) => [
      rowPath('lines', index, 'shipmentId'),
      rowPath('lines', index, 'charge'),
    ]).flat(),
  ];
}

// The account select's option: what it holds, so the person picks the one whose money arrived.
// Without a COD account there is nothing to pay out: shown, but not offered
function useAccountOption(): (account: PayoutAccount) => {
  value: string;
  label: string;
  disabled: boolean;
} {
  const { t, format } = useLocale();
  const nameOf = usePayoutAccountName();
  return (account) => {
    const name = nameOf(account);
    if (account.codAccount === null) {
      return {
        value: account.id,
        label: t('storefront.payout.accountNoCod', { name }),
        disabled: true,
      };
    }
    return {
      value: account.id,
      label:
        account.holds.parcels === 0
          ? t('storefront.payout.accountHoldsNothing', { name })
          : t('storefront.payout.accountHolds', {
              name,
              amount: format.money(account.holds.amount, { decimals: 0 }),
              count: account.holds.parcels,
              formatted: format.number(account.holds.parcels),
            }),
      disabled: false,
    };
  };
}

export function PayoutForm({
  setup,
  accountId: startAccount,
  today,
}: {
  setup: PayoutSetup;
  // From "Record payout" in a courier account's row menu; '' = pick one
  accountId: string;
  today: string;
}) {
  const { t, errorText } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const optionOf = useAccountOption();
  const nameOf = usePayoutAccountName();
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    clearErrors,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(payoutInputSchema, { error: contractErrorMap }),
    defaultValues: {
      accountId: startAccount,
      date: today,
      // One bank account needs no choice
      bankAccountId: setup.bankAccounts.length === 1 ? (setup.bankAccounts[0]?.id ?? '') : '',
      reference: '',
      note: '',
      lines: [],
    },
  });
  const accountId = useWatch({ control, name: 'accountId' });
  const account = setup.accounts.find((choice) => choice.id === accountId) ?? null;
  // Decision 7: the money leaves the COD account for the bank, so the COD account is never the bank
  const bankChoices = setup.bankAccounts.filter((choice) => choice.id !== account?.codAccount?.id);
  const canPay = account !== null && account.codAccount !== null;
  const parcelsQuery = useQuery({
    ...storefrontPayoutParcelsQuery(tenantId, accountId),
    enabled: canPay,
  });
  const parcels = parcelsQuery.data?.parcels;
  // The charge boxes, ticked or not, from what the courier said; and the file's bank figure once
  // a file was matched. Both belong to one account: picking another starts them again
  const [drafts, setDrafts] = useState<ChargeDrafts | null>(null);
  const [fileNet, setFileNet] = useState<string | null>(null);
  const [fileOpen, setFileOpen] = useState(false);
  const shownDrafts = drafts ?? (parcels ? startDrafts(parcels) : {});

  const pickAccount = (next: string) => {
    setValue('accountId', next, { shouldValidate: errors.accountId !== undefined });
    setValue('lines', []);
    setDrafts(null);
    setFileNet(null);
    clearErrors('lines');
    // The COD account of the new courier is no bank for its own payout
    const cod = setup.accounts.find((choice) => choice.id === next)?.codAccount?.id;
    if (cod !== undefined && getValues('bankAccountId') === cod) setValue('bankAccountId', '');
    // The address names the account, so a reload or Back keeps it (replace: not a new page)
    void navigate({
      to: '/storefront/payouts/new',
      search: next === '' ? {} : { account: next },
      replace: true,
    });
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.storefrontPayouts.create, { body: values });
      // The couriers' Holds, the parcels' "Paid out on" and the journal all changed
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['storefront', tenantId] }),
        queryClient.invalidateQueries({ queryKey: ['journal', tenantId] }),
      ]);
      toast(t('storefront.payout.created', { number: saved.number }));
      void navigate({
        to: '/storefront/payouts/$payoutId',
        params: { payoutId: saved.id },
        replace: true,
      });
    } catch (error) {
      // Another payout took a parcel, or its receipt was voided a moment ago: the parcels are read
      // again, the lines of the ones gone are dropped, and the error stays at the top, where it
      // still makes sense once its row is gone
      if (error instanceof ApiRequestError && error.code === 'payout_parcel_unavailable') {
        const fresh = (await parcelsQuery.refetch()).data?.parcels ?? [];
        const listed = new Set(fresh.map((parcel) => parcel.shipmentId));
        setValue(
          'lines',
          getValues('lines').filter((line) => listed.has(line.shipmentId)),
        );
        setError('root.server', { message: 'payout_parcel_unavailable' });
        return;
      }
      applyApiError(error, fieldNames(getValues('lines').length), setError);
    }
  });

  const failure = errors.root?.server?.message;
  const courier = account === null ? '' : t(`storefront.couriers.names.${account.courier}`);

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PayoutBackLink />
      <PageHeader
        title={t('storefront.payout.newTitle')}
        description={t('storefront.payout.newDescription')}
      />
      <form
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <div className="sm:col-span-2">
            <SelectField
              label={t('storefront.payout.account')}
              icon={ShippingTruck01Icon}
              options={[
                { value: '', label: t('storefront.payout.accountPlaceholder') },
                ...setup.accounts.map(optionOf),
              ]}
              {...register('accountId')}
              onChange={(event) => {
                pickAccount(event.target.value);
              }}
              error={errors.accountId?.message}
            />
          </div>
          <FormField
            control={control}
            name="date"
            label={t('storefront.payout.date')}
            hint={t('storefront.payout.dateHint')}
          >
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <div className="sm:col-span-2">
            <SelectField
              label={t('storefront.payout.bankAccount')}
              icon={Wallet01Icon}
              hint={t('storefront.payout.bankAccountHint')}
              disabled={bankChoices.length === 0}
              options={[
                { value: '', label: t('storefront.payout.bankAccountPlaceholder') },
                ...bankChoices.map((choice) => ({
                  value: choice.id,
                  label: `${choice.code} · ${choice.name}`,
                })),
              ]}
              {...register('bankAccountId')}
              // Nothing to pick is said as an error at once (approved with the mockup): the form
              // can't be saved until someone fixes the chart
              error={
                bankChoices.length === 0
                  ? t('storefront.payout.noBankAccounts')
                  : errors.bankAccountId?.message
              }
            />
          </div>
          <TextField
            label={t('storefront.payout.reference')}
            icon={Tag01Icon}
            optional
            placeholder={t('storefront.payout.referencePlaceholder')}
            hint={t('storefront.payout.referenceHint')}
            {...register('reference')}
            error={errors.reference?.message}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('storefront.payout.note')}
              icon={Note01Icon}
              optional
              placeholder={t('storefront.payout.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>

        {/* Before the parcels: a charge has nowhere to go, so only parcels with no charge can be
            paid out (the API refuses the rest, payout_account_no_charges) */}
        {account !== null && account.codAccount !== null && account.chargeAccount === null && (
          <DocumentNotice tone="warn" icon={Alert02Icon}>
            {t('storefront.payout.noChargeAccount', { name: account.name })}
          </DocumentNotice>
        )}

        <Card className="@container overflow-hidden">
          <CardHeader
            title={t('storefront.payout.parcelsTitle')}
            subtitle={
              account === null
                ? undefined
                : t('storefront.payout.parcelsDescription', { name: account.name })
            }
            actions={
              parcels !== undefined &&
              parcels.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setFileOpen(true);
                  }}
                >
                  <HugeiconsIcon icon={FileImportIcon} size={16} strokeWidth={1.5} />
                  {t('storefront.payout.matchFile')}
                </Button>
              )
            }
          />
          {!canPay ? (
            <p className="flex items-start gap-1.5 px-5 pt-3 pb-5 text-label text-ink-2">
              <HugeiconsIcon
                icon={InformationCircleIcon}
                size={15}
                strokeWidth={1.5}
                className="mt-0.5 shrink-0 text-ink-3"
              />
              {t('storefront.payout.pickAccountFirst')}
            </p>
          ) : parcelsQuery.isError ? (
            <p className="px-5 pt-3 pb-5 text-body-sm text-crit">{errorText('unknown_error')}</p>
          ) : parcels === undefined ? null : parcels.length === 0 ? (
            <EmptyState
              icon={BankIcon}
              title={t('storefront.payout.noParcelsTitle')}
              description={t('storefront.payout.noParcelsBody', { name: account.name })}
            />
          ) : (
            <Controller
              control={control}
              name="lines"
              render={({ field }) => (
                <ParcelsTable
                  parcels={parcels}
                  courier={courier}
                  lines={field.value}
                  drafts={shownDrafts}
                  onChange={(lines, nextDrafts) => {
                    field.onChange(lines);
                    setDrafts(nextDrafts);
                  }}
                  errors={errors}
                  fileNet={fileNet}
                />
              )}
            />
          )}
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-3">
          <p className="mr-auto max-w-xl text-label text-ink-3">
            {t('storefront.payout.saveHint')}
          </p>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('storefront.payout.save')}
          </Button>
        </div>
      </form>

      <Dialog open={fileOpen} onOpenChange={setFileOpen}>
        <Suspense fallback={null}>
          {fileOpen && account !== null && parcels !== undefined && (
            <PayoutFileDialog
              accountId={account.id}
              accountName={nameOf(account)}
              parcels={parcels}
              onApply={(rows: readonly PayoutMatchRow[], net: string | null) => {
                const applied = applyMatch(parcels, getValues('lines'), shownDrafts, rows);
                setValue('lines', applied.lines, { shouldValidate: errors.lines !== undefined });
                setDrafts(applied.drafts);
                setFileNet(net);
                setFileOpen(false);
                toast(
                  t('storefront.payout.csv.applied', {
                    count: applied.ticked,
                    formatted: String(applied.ticked),
                  }),
                );
              }}
            />
          )}
        </Suspense>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The parcels

// One grid template for the caption header and every row on a wide card (@3xl); on a narrow one
// each row is a card of its own with labels (P7), like the line editors
const GRID =
  '@3xl:grid @3xl:grid-cols-[1.25rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_7rem_9.5rem_7rem] @3xl:items-start @3xl:gap-x-4';

function ParcelsTable({
  parcels,
  courier,
  lines,
  drafts,
  onChange,
  errors,
  fileNet,
}: {
  parcels: readonly PayoutParcel[];
  // The courier's name, for "Steadfast said ৳60"
  courier: string;
  lines: readonly PayoutLineValue[];
  drafts: ChargeDrafts;
  onChange: (lines: PayoutLineValue[], drafts: ChargeDrafts) => void;
  errors: FieldErrors<FormValues>;
  // The file's bank figure, after a match (P4)
  fileNet: string | null;
}) {
  const { t, format, errorText } = useLocale();
  const isoDate = useIsoDate();
  const shopMoney = useShopMoney();
  const money = (value: string) => format.money(value, { decimals: 2 });
  const totals = payoutTotals(parcels, lines);
  const difference = fileNet === null ? null : fileDifference(totals.net, fileNet);
  const listError = errors.lines?.root?.message ?? errors.lines?.message;

  const tick = (parcel: PayoutParcel, on: boolean) => {
    const rest = lines.filter((line) => line.shipmentId !== parcel.shipmentId);
    onChange(
      on
        ? orderLines(parcels, [
            ...rest,
            { shipmentId: parcel.shipmentId, charge: drafts[parcel.shipmentId] ?? '' },
          ])
        : rest,
      drafts,
    );
  };
  const charge = (parcel: PayoutParcel, value: string) => {
    onChange(
      lines.map((line) =>
        line.shipmentId === parcel.shipmentId ? { ...line, charge: value } : line,
      ),
      { ...drafts, [parcel.shipmentId]: value },
    );
  };

  return (
    <div className="grid grid-cols-1">
      <div className="flex flex-wrap gap-2 px-5 py-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={lines.length === parcels.length}
          onClick={() => {
            onChange(
              parcels.map((parcel) => ({
                shipmentId: parcel.shipmentId,
                charge: drafts[parcel.shipmentId] ?? '',
              })),
              drafts,
            );
          }}
        >
          {t('storefront.payout.tickAll')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={lines.length === 0}
          onClick={() => {
            onChange([], drafts);
          }}
        >
          {t('storefront.payout.clear')}
        </Button>
      </div>
      {/* The header only on a wide card: on a narrow one each row says its own labels */}
      <div
        aria-hidden="true"
        className={cn('hidden bg-subtle px-5 py-2.5 text-caption font-medium text-ink-3', GRID)}
      >
        <span />
        <span>{t('storefront.payout.columns.parcel')}</span>
        <span>{t('storefront.payout.columns.status')}</span>
        <span>{t('storefront.payout.columns.receipt')}</span>
        <span className="text-right">{t('storefront.payout.columns.collected')}</span>
        <span className="text-right">{t('storefront.payout.columns.charge')}</span>
        <span className="text-right">{t('storefront.payout.columns.net')}</span>
      </div>
      <ul className="grid grid-cols-1">
        {parcels.map((parcel) => {
          const index = lines.findIndex((line) => line.shipmentId === parcel.shipmentId);
          const on = index !== -1;
          const line = on ? lines[index] : undefined;
          const error = on
            ? (errors.lines?.[index]?.charge?.message ?? errors.lines?.[index]?.shipmentId?.message)
            : undefined;
          const id = `payout-${parcel.shipmentId}`;
          const value = drafts[parcel.shipmentId] ?? '';
          const net = on && line ? payoutTotals([parcel], [line]).net : null;
          return (
            <li
              key={parcel.shipmentId}
              role="group"
              aria-label={parcel.invoice}
              className={cn(
                'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 border-t border-line px-5 py-3 text-body-sm',
                GRID,
              )}
            >
              <div className="row-span-1 pt-0.5">
                <Checkbox
                  id={id}
                  hideLabel
                  label={t('storefront.payout.tick', { invoice: parcel.invoice })}
                  checked={on}
                  onCheckedChange={(checked) => {
                    tick(parcel, checked === true);
                  }}
                />
              </div>
              <div className="flex min-w-0 items-start justify-between gap-2 @3xl:block">
                <span className="grid min-w-0">
                  <span className="font-mono font-medium tabular-nums text-ink">
                    {parcel.invoice}
                  </span>
                  <span className="text-caption text-ink-3">
                    {t(`storefront.payout.kinds.${parcel.kind}`)}
                  </span>
                  {parcel.trackingCode !== null && (
                    <span className="truncate font-mono text-caption text-ink-3">
                      {parcel.trackingCode}
                    </span>
                  )}
                </span>
                {/* On a phone the pill sits beside the number, as the card's title row */}
                <span className="@3xl:hidden">
                  <ParcelPill status={parcel.status} />
                </span>
              </div>
              <div className="col-start-2 hidden @3xl:col-start-auto @3xl:block">
                <ParcelPill status={parcel.status} />
              </div>
              <Cell label={t('storefront.payout.columns.receipt')}>
                {parcel.receipt === null ? (
                  <span className="text-ink-3">—</span>
                ) : (
                  <span className="grid @3xl:justify-items-start">
                    {/* Every member reads money receipts, so it is always a link */}
                    <Link
                      to="/receipts/$receiptId"
                      params={{ receiptId: parcel.receipt.id }}
                      className="font-mono font-medium text-brand underline-offset-3 hover:underline"
                    >
                      {parcel.receipt.number ?? '—'}
                    </Link>
                    {parcel.receiptDate !== null && (
                      <span className="hidden text-caption text-ink-3 tabular-nums @3xl:block">
                        {isoDate(parcel.receiptDate)}
                      </span>
                    )}
                  </span>
                )}
              </Cell>
              <Cell label={t('storefront.payout.columns.collected')} end>
                <span className={on ? 'tabular-nums' : 'text-ink-3 tabular-nums'}>
                  {money(parcel.collected)}
                </span>
              </Cell>
              <div className="col-start-2 grid gap-1 @3xl:col-start-auto">
                <label
                  htmlFor={`${id}-charge`}
                  className="text-label font-medium text-ink @3xl:sr-only"
                >
                  {t('storefront.payout.columns.charge')}
                </label>
                <MoneyInput
                  id={`${id}-charge`}
                  aria-label={t('storefront.payout.chargeLabel', { invoice: parcel.invoice })}
                  value={value}
                  disabled={!on}
                  invalid={error !== undefined}
                  aria-describedby={error ? `${id}-error` : `${id}-said`}
                  onChange={(next) => {
                    charge(parcel, next);
                  }}
                />
                {error ? (
                  <span id={`${id}-error`} className="flex items-start gap-1 text-label text-crit">
                    <HugeiconsIcon
                      icon={Alert02Icon}
                      size={15}
                      strokeWidth={1.5}
                      className="mt-0.5 shrink-0"
                    />
                    {errorText(error)}
                  </span>
                ) : (
                  <span id={`${id}-said`} className="text-caption text-ink-3 @3xl:text-right">
                    {parcel.courierCharge === null
                      ? t('storefront.payout.courierSilent', { courier })
                      : t('storefront.payout.courierSaid', {
                          courier,
                          amount: shopMoney(parcel.courierCharge),
                        })}
                  </span>
                )}
              </div>
              <Cell label={t('storefront.payout.columns.net')} end>
                {net === null ? (
                  <span className="text-ink-3">—</span>
                ) : (
                  <span className="font-medium tabular-nums">{money(net)}</span>
                )}
              </Cell>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3 border-t border-line bg-subtle px-5 py-3.5 text-body-sm tabular-nums">
        <span className="font-medium">
          {t('storefront.payout.ticked', {
            count: lines.length,
            formatted: format.number(lines.length),
          })}
        </span>
        <dl className="ml-auto grid w-full grid-cols-[auto_auto] justify-between gap-x-6 gap-y-1 sm:w-auto">
          <dt className="text-ink-2">{t('storefront.payout.collected')}</dt>
          <dd className="text-right">{money(totals.collected)}</dd>
          <dt className="text-ink-2">{t('storefront.payout.charges')}</dt>
          <dd className="text-right">{money(totals.charges)}</dd>
          <dt className="font-medium">{t('storefront.payout.net')}</dt>
          <dd className="text-right font-medium">{money(totals.net)}</dd>
          {fileNet !== null && (
            // P4: the file's own bank figure, so a wrong charge shows before saving. The pill
            // has its icon and its words: the colour is never the only sign
            <div className="col-span-2 mt-1 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-2 text-label text-ink-2">
              <dt>{t('storefront.payout.fileNet', { amount: money(fileNet) })}</dt>
              <dd>
                {difference === null ? (
                  <Pill tone="good" icon={CheckmarkCircle02Icon}>
                    {t('storefront.payout.fileAgrees')}
                  </Pill>
                ) : (
                  <Pill tone="crit" icon={Alert02Icon}>
                    {t('storefront.payout.fileOutBy', { amount: money(difference) })}
                  </Pill>
                )}
              </dd>
            </div>
          )}
        </dl>
      </div>
      {listError && (
        <p className="flex items-center gap-1.5 border-t border-line px-5 py-3 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {errorText(listError)}
        </p>
      )}
    </div>
  );
}

// A value with its label on a narrow card (left, ink-3) and alone in its column on a wide one
function Cell({
  label,
  end = false,
  children,
}: {
  label: string;
  end?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'col-start-2 flex items-baseline justify-between gap-3 @3xl:col-start-auto @3xl:block',
        end && '@3xl:text-right',
      )}
    >
      <span className="text-ink-3 @3xl:sr-only">{label}</span>
      {children}
    </div>
  );
}
