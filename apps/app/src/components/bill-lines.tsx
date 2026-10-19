import {
  Alert02Icon,
  Calendar03Icon,
  PackageReceiveIcon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type Account,
  type BillLineFormValues,
  draftLineAmounts,
  isZeroMoney,
  MAX_BILL_LINES,
  priceDifferenceOf,
  subtractMoney,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Dialog, Input, Select } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import type { FieldErrors } from 'react-hook-form';

import type { BillSourcedLine } from '../lib/bill-sources';
import { type BillLineOrigin, billSourceIdOf, ownBillLine } from '../lib/bills';
import { taxRatesQuery } from '../lib/queries';
import { isServiceLine, type LineMeta, type SalesItem } from '../lib/sales';
import { firstMessage } from '../lib/stock';
import { usePurchasePricing } from './purchase-pricing';
import { LinesEditor, SalesField } from './sales-line-editor';
import { SerialNumbersInput } from './serial-numbers-input';
import { useTenantId } from './stock-parts';

// The item lines of a supplier bill (step 17c): the sales line editor of the purchase order
// (decision 15), with the invoice's three kinds of line (15c). A goods receipt line and an order's
// service line are billed whole, so their item, unit and quantity are fixed; a line of its own is
// a normal line at the supplier's last price. Under each line, what the line needs beside a sales
// line: the order's price and the difference (decision 8), the expense account of a service
// (decision 16), or the lot of goods the bill receives itself. Its own chunk, loaded by the bill
// form (sales-line-editor.tsx says why the editor is lazy).

// The date boxes of an own goods line bring the popover, like everywhere else; the two pickers are
// a chunk of their own (bill-pickers.tsx says why)
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));
const ReceiptPicker = lazy(async () => ({
  default: (await import('./bill-pickers')).ReceiptPicker,
}));
const ServicePicker = lazy(async () => ({
  default: (await import('./bill-pickers')).ServicePicker,
}));

export type BillLinesErrors = FieldErrors<{ lines: BillLineFormValues[] }>['lines'];

type Add = (entries: readonly { line: BillLineFormValues; meta: LineMeta }[]) => boolean;

// Billed whole: a goods receipt line, or an order's service line
function isBilled(line: BillLineFormValues): boolean {
  return billSourceIdOf(line) !== null;
}

export function BillLinesEditor({
  lines,
  onChange,
  getLines,
  initialMeta,
  supplierId,
  pricesIncludeVat,
  errors,
  origins,
  orderPricing,
  accounts,
  servicesAccount,
  onSourced,
}: {
  lines: BillLineFormValues[];
  onChange: (lines: BillLineFormValues[]) => void;
  getLines: () => BillLineFormValues[];
  initialMeta: LineMeta[];
  supplierId: string;
  pricesIncludeVat: boolean;
  errors: BillLinesErrors;
  origins: ReadonlyMap<string, BillLineOrigin>;
  // How the order lines on the form write their prices (null = no order line yet)
  orderPricing: boolean | null;
  // The accounts a service line may post to (costAccounts), and Settings' "Purchased services"
  // (null = none chosen): what an empty account box stands for
  accounts: readonly Account[];
  servicesAccount: Account | null;
  // Lines a picker added: the form keeps where they came from
  onSourced: (lines: readonly BillSourcedLine[]) => void;
}) {
  const { t, format, errorText } = useLocale();
  const tenantId = useTenantId();
  const rates = useQuery(taxRatesQuery(tenantId)).data;
  const rateOf = (id: string) => rates?.find((rate) => rate.id === id)?.rate ?? null;
  const pricing = usePurchasePricing(supplierId, pricesIncludeVat, t('bills.noLines'));
  const [picking, setPicking] = useState<'receipts' | 'services' | null>(null);
  const onForm = new Set(lines.flatMap((line) => billSourceIdOf(line) ?? []));
  const money = (value: string) => format.money(value, { decimals: 2 });

  // A service line's expense account (decision 16): empty = Settings' "Purchased services", named
  // in the empty option so the person sees where it goes. With none chosen there, the empty
  // option says to pick one, the same words the API answers with (bill_account_required).
  const accountBox = (
    index: number,
    value: BillLineFormValues,
    update: (patch: Partial<BillLineFormValues>) => void,
  ) => {
    const id = `lines.${String(index)}.accountId`;
    const error = errors?.[index]?.accountId?.message;
    return (
      <SalesField id={id} label={t('bills.account')} error={error}>
        <Select
          id={id}
          value={value.accountId ?? ''}
          invalid={error !== undefined}
          options={[
            {
              value: '',
              label: servicesAccount
                ? t('bills.accountDefault', {
                    account: `${servicesAccount.code} · ${servicesAccount.name}`,
                  })
                : t('bills.accountPlaceholder'),
            },
            ...accounts.map((account) => ({
              value: account.id,
              label: `${account.code} · ${account.name}`,
            })),
          ]}
          onChange={(event) => {
            update({ accountId: event.target.value });
          }}
        />
        {servicesAccount === null && (value.accountId ?? '') === '' && error === undefined && (
          <span className="text-caption text-ink-3">{t('bills.accountRequired')}</span>
        )}
      </SalesField>
    );
  };

  const note = ({
    value,
    index,
    item,
    update,
  }: {
    value: BillLineFormValues;
    index: number;
    item: SalesItem;
    update: (patch: Partial<BillLineFormValues>) => void;
  }): ReactNode => {
    const lineErrors = errors?.[index];
    const origin = origins.get(billSourceIdOf(value) ?? '');
    // A billed line's own problem: billed by another bill since, not this supplier's, or (a line
    // whose unit and quantity are fixed) not billed whole. The fixed cells have no box to show it
    // under, so it shows here.
    const sourceError =
      lineErrors?.receiptLineId?.message ??
      lineErrors?.orderLineId?.message ??
      lineErrors?.quantity?.message ??
      lineErrors?.unitId?.message;
    if (value.receiptLineId) {
      const amount = draftLineAmounts(value, rateOf(value.taxRateId), pricesIncludeVat);
      const orderValue = origin?.orderValue ?? null;
      const difference =
        amount && orderValue !== null ? priceDifferenceOf({ ...amount, orderValue }) : null;
      return (
        <span className="grid gap-0.5 text-caption text-ink-3">
          <span className="font-medium text-ink-2">
            {t('bills.fromReceipt', { number: origin?.receiptNumber ?? '' })}
            {origin?.orderNumber && ` · ${origin.orderNumber}`}
          </span>
          <span>{t('bills.receiptLineHint')}</span>
          {/* What the goods receipt booked, and how far this price is from it (decision 8). Before
              VAT, like the books: the difference goes to an account at its net. */}
          {orderValue !== null && (
            <span className="tabular-nums">
              {t('bills.orderValue', { amount: money(orderValue) })}
              {difference !== null && !isZeroMoney(difference) && (
                <span className="font-medium text-ink-2">
                  {' · '}
                  {difference.startsWith('-')
                    ? t('bills.underOrder', { amount: money(subtractMoney('0', difference)) })
                    : t('bills.overOrder', { amount: money(difference) })}
                </span>
              )}
            </span>
          )}
          <SourceError message={sourceError} />
        </span>
      );
    }
    if (value.orderLineId) {
      return (
        <span className="grid gap-2">
          <span className="grid gap-0.5 text-caption">
            <span className="font-medium text-ink-2">
              {t('bills.fromOrder', { number: origin?.orderNumber ?? '' })}
            </span>
            <SourceError message={sourceError} />
          </span>
          {accountBox(index, value, update)}
        </span>
      );
    }
    if (isServiceLine(item)) return accountBox(index, value, update);
    return (
      <OwnGoods
        index={index}
        item={item}
        line={value}
        update={update}
        errors={{
          lotNumber: lineErrors?.lotNumber?.message,
          expiresOn: lineErrors?.expiresOn?.message,
          manufacturedOn: lineErrors?.manufacturedOn?.message,
          serialNumbers: firstMessage(lineErrors?.serialNumbers),
          // bill_account_not_allowed: an account on goods (a product changed to goods since)
          accountId: lineErrors?.accountId?.message,
        }}
      />
    );
  };

  // What both pickers share: add the lines unless they would mix the orders' two ways of writing
  // prices (the API's bill_vat_mixed) or pass the line limit; say why in the dialog otherwise
  const addSourced = (sourced: readonly BillSourcedLine[], setting: boolean | null, add: Add) => {
    if (setting !== null && orderPricing !== null && setting !== orderPricing) {
      return errorText('bill_vat_mixed');
    }
    if (!add(sourced.map(({ line, meta }) => ({ line, meta })))) {
      return t('purchaseLines.tooMany', { max: MAX_BILL_LINES });
    }
    onSourced(sourced);
    return null;
  };

  return (
    <LinesEditor<BillLineFormValues>
      lines={lines}
      onChange={onChange}
      getLines={getLines}
      initialMeta={initialMeta}
      pricing={pricing}
      pricesIncludeVat={pricesIncludeVat}
      errors={errors}
      newLine={ownBillLine}
      maxLines={MAX_BILL_LINES}
      fixed={isBilled}
      lineNote={note}
      // The bill's totals count its expenses too, so the form shows them under the expenses
      totals={false}
      moreAdds={(add) => (
        <>
          <Button
            variant="secondary"
            size="sm"
            disabled={supplierId === ''}
            onClick={() => {
              setPicking('receipts');
            }}
          >
            <HugeiconsIcon icon={PackageReceiveIcon} size={16} strokeWidth={1.5} />
            {t('bills.addReceipts')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={supplierId === ''}
            onClick={() => {
              setPicking('services');
            }}
          >
            <HugeiconsIcon icon={Wrench01Icon} size={16} strokeWidth={1.5} />
            {t('bills.addServices')}
          </Button>
          {supplierId === '' && (
            <span className="self-center text-label text-ink-3">
              {t('bills.pickSupplierFirst')}
            </span>
          )}
          <Dialog
            open={picking !== null}
            onOpenChange={(open) => {
              if (!open) setPicking(null);
            }}
          >
            <Suspense fallback={null}>
              {picking === 'receipts' && (
                <ReceiptPicker
                  supplierId={supplierId}
                  onForm={onForm}
                  addSourced={(sourced, setting) => addSourced(sourced, setting, add)}
                />
              )}
              {picking === 'services' && (
                <ServicePicker
                  supplierId={supplierId}
                  onForm={onForm}
                  addSourced={(sourced, setting) => addSourced(sourced, setting, add)}
                />
              )}
            </Suspense>
          </Dialog>
        </>
      )}
    />
  );
}

function SourceError({ message }: { message: string | undefined }) {
  const { errorText } = useLocale();
  if (message === undefined) return null;
  return (
    <span className="flex items-start gap-1.5 text-label text-crit">
      <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="mt-px shrink-0" />
      {errorText(message)}
    </span>
  );
}

// The lot, its dates or the serial numbers of a goods line the bill receives itself, like a goods
// receipt line (17b): posting the bill posts a goods receipt with them (decision 4). The API asks
// for them by the product's tracking, like any receipt.
function OwnGoods({
  index,
  item,
  line,
  update,
  errors,
}: {
  index: number;
  item: SalesItem;
  line: BillLineFormValues;
  update: (patch: Partial<BillLineFormValues>) => void;
  errors: {
    lotNumber: string | undefined;
    expiresOn: string | undefined;
    manufacturedOn: string | undefined;
    serialNumbers: string | undefined;
    accountId: string | undefined;
  };
}) {
  const { t } = useLocale();
  const id = (field: string) => `lines.${String(index)}.${field}`;
  return (
    <div className="grid gap-2">
      <span className="text-caption font-medium text-ink-2">{t('bills.ownLine')}</span>
      <SourceError message={errors.accountId} />
      {item.tracking === 'batch' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SalesField id={id('lotNumber')} label={t('stockLines.lot')} error={errors.lotNumber}>
            <Input
              id={id('lotNumber')}
              autoComplete="off"
              spellCheck={false}
              placeholder="NP24117"
              value={line.lotNumber ?? ''}
              invalid={errors.lotNumber !== undefined}
              onChange={(event) => {
                update({ lotNumber: event.target.value });
              }}
            />
          </SalesField>
          {(['expiresOn', 'manufacturedOn'] as const).map((date) => (
            <SalesField
              key={date}
              id={id(date)}
              label={t(`stockLines.${date}`)}
              error={errors[date]}
            >
              <Suspense fallback={<Input id={id(date)} icon={Calendar03Icon} disabled />}>
                <DatePicker
                  id={id(date)}
                  value={line[date] ?? ''}
                  invalid={errors[date] !== undefined}
                  onChange={(value) => {
                    update(date === 'expiresOn' ? { expiresOn: value } : { manufacturedOn: value });
                  }}
                />
              </Suspense>
            </SalesField>
          ))}
        </div>
      )}
      {item.tracking === 'serial' && (
        <SalesField
          id={id('serialNumbers')}
          label={t('stockLines.serials')}
          error={errors.serialNumbers}
        >
          <SerialNumbersInput
            id={id('serialNumbers')}
            value={line.serialNumbers}
            invalid={errors.serialNumbers !== undefined}
            onChange={(serialNumbers) => {
              update({ serialNumbers });
            }}
          />
          <span className="text-caption text-ink-3">{t('stockLines.serialsHint')}</span>
        </SalesField>
      )}
    </div>
  );
}
