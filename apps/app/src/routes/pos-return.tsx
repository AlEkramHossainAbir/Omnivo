import { AlertCircleIcon, HourglassIcon, PrinterIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  defaultLineDescription,
  type PosRegister,
  type PosReturn,
  todayIn,
  type Unit,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, EmptyState, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { Fact } from '../components/adjustment-view';
import { DocumentNotice } from '../components/document-notice';
import { EntryLinks } from '../components/entry-links';
import { useReceiptCompany } from '../components/pos-parts';
import { PosReturnPills, ShiftFact } from '../components/pos-sale-parts';
import { SalesBackLink, SalesTotals } from '../components/sales-parts';
import { useIsoDate, useQuantity, useTenantId, useTimeZone } from '../components/stock-parts';
import type { ReturnSlipData } from '../lib/pos-returns';
import { posRegisterQuery, posReturnQuery } from '../lib/pos-queries';
import { settingsQuery, unitsQuery } from '../lib/queries';
import { variantName } from '../lib/stock';
import { useOnline } from '../lib/use-online';

// Step 20c: one POS return, as the server posted it: the sale it came from, what came back and
// into which batch, how the money went back (or which sale it paid for), and its journal entry.
// The POS sale's page's twin, key for key. "Print return slip" prints the slip the counter
// printed, for a customer who needs it again.

const PosReturnSlip = lazy(async () => ({
  default: (await import('../components/pos-receipt')).PosReturnSlip,
}));

// The slip from the server's return, as the counter made it (returnSlipOf in lib/pos-returns.ts):
// a line pays back its total with VAT, and an exchange's money is "Used on" its sale, not a refund
// row. The register's paper and footer are today's, like a sale's reprint.
function slipOfReturn(
  item: PosReturn,
  register: Pick<PosRegister, 'paperWidth' | 'receiptFooter'>,
  units: readonly Unit[],
): ReturnSlipData {
  return {
    number: item.number,
    returnedAt: item.returnedAt,
    registerCode: item.register.code,
    paperWidth: register.paperWidth,
    receiptFooter: register.receiptFooter,
    cashier: item.cashier.fullName,
    sale: { number: item.sale.number, date: item.sale.date },
    customerName: item.customer?.name ?? null,
    lines: item.lines.map((line) => {
      const unit = units.find((one) => one.id === line.unitId);
      return {
        key: line.id,
        name: line.description,
        quantity: line.quantity,
        decimals: unit?.decimals ?? 0,
        unitCode: unit?.code ?? '',
        unitPrice: line.unitPrice,
        total: line.total,
        serialNumbers: line.serialNumbers,
      };
    }),
    net: item.net,
    vat: item.vat,
    total: item.total,
    refunds: item.refunds
      .filter((refund) => refund.method !== 'exchange')
      .map(({ method, amount, reference }) => ({ method, amount, reference })),
    usedOn: item.exchangeSale?.number ?? null,
    note: item.note,
  };
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/pos/returns" label={t('posReturns.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('posReturns.title')} description={message} />
    </div>
  );
}

export function PosReturnPage() {
  const { t } = useLocale();
  const online = useOnline();
  const { returnId = '' } = useParams({ strict: false });
  const { data: item, isError } = useQuery({
    ...posReturnQuery(useTenantId(), returnId),
    enabled: returnId !== '',
  });
  if (isError) return <CantFind message={t('posReturns.notFound')} />;
  // Offline before it ever loaded: the returns are read from the server only
  if (!item) return online ? null : <CantFind message={t('posReturns.needsConnection')} />;
  return <PosReturnView item={item} />;
}

function PosReturnView({ item }: { item: PosReturn }) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const register = useQuery(posRegisterQuery(tenantId, item.register.id)).data;
  const units = useQuery(unitsQuery(tenantId)).data;
  const settings = useQuery(settingsQuery(tenantId)).data;
  const money = (value: string) => format.money(value, { decimals: 2 });
  // Like a sale (20a decision 26): the day it came back by the device, against its day in the books
  const returnedOn = todayIn(timeZone, new Date(item.returnedAt));
  const registerName = `${item.register.code} · ${item.register.name}`;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/pos/returns" label={t('posReturns.back')} />
      <PageHeader
        title={item.number}
        description={item.customer?.name ?? t('posReturns.walkIn')}
        actions={
          <>
            <PosReturnPills item={item} />
            {/* Ready once the register (its paper) and the company are loaded */}
            {register && units && settings && (
              <Button
                variant="secondary"
                className="gap-1.5"
                onClick={() => {
                  window.print();
                }}
              >
                <HugeiconsIcon icon={PrinterIcon} size={17} strokeWidth={1.5} />
                {t('posReturns.print')}
              </Button>
            )}
          </>
        }
      />
      {returnedOn !== item.date && (
        <DocumentNotice tone="neutral">
          {t('posReturns.bookedLater', { returned: isoDate(returnedOn), date: isoDate(item.date) })}
        </DocumentNotice>
      )}
      {/* Decision 20: the server took it anyway; the warn tone, like a credit note long after
          its invoice, because a manager may want to ask the counter why */}
      {item.outsideWindow && (
        <DocumentNotice tone="warn" icon={HourglassIcon}>
          {t('posReturns.outsideWindowNotice', {
            number: item.sale.number,
            register: registerName,
          })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('posReturns.sale')}</span>
          <Link
            to="/pos/sales/$saleId"
            params={{ saleId: item.sale.id }}
            className="w-fit font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline"
          >
            {item.sale.number}
          </Link>
        </div>
        <Fact label={t('posReturns.soldOn')} value={isoDate(item.sale.date)} />
        <Fact
          label={t('posReturns.customer')}
          value={item.customer?.name ?? t('posReturns.walkIn')}
        />
        <Fact label={t('posReturns.columns.date')} value={isoDate(item.date)} />
        <Fact
          label={t('posReturns.returnedAt')}
          value={format.dateTime(new Date(item.returnedAt), timeZone)}
        />
        <Fact label={t('posReturns.register')} value={registerName} />
        <Fact label={t('posReturns.cashier')} value={item.cashier.fullName} />
        <Fact label={t('posReturns.device')} value={item.device.name} />
        <ShiftFact label={t('posReturns.shift')} shift={item.shift} />
        <EntryLinks
          label={t('posReturns.entry')}
          entries={item.entry ? [item.entry] : []}
          none="—"
        />
        {item.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('posReturns.note')} value={item.note} />
          </div>
        )}
      </Card>
      <LinesCard item={item} money={money} quantity={quantity} />
      <RefundsCard item={item} money={money} />
      {register && units && settings && (
        <Suspense fallback={null}>
          <ReprintSheet item={item} register={register} units={units} settings={settings} />
        </Suspense>
      )}
    </div>
  );
}

// What came back, in the sale line's unit and at its price (decision 17). Not SalesLinesTable: a
// return line has no discount and no VAT rate of its own (they are the sale line's, decision 35),
// so its columns would be empty. Its own small table with the same look, and the same totals.
function LinesCard({
  item,
  money,
  quantity,
}: {
  item: PosReturn;
  money: (value: string) => string;
  quantity: ReturnType<typeof useQuantity>;
}) {
  const { t } = useLocale();
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-body-sm">
          <caption className="sr-only">{t('posReturns.lines')}</caption>
          <thead>
            <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
              <th scope="col" className="px-5 py-2.5">
                {t('salesLines.item')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('salesLines.quantity')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {item.pricesIncludeVat
                  ? t('salesLines.priceWithVat')
                  : t('salesLines.priceWithoutVat')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('salesLines.amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {item.lines.map((line) => (
              <tr key={line.id} className="border-t border-line align-top">
                <td className="px-5 py-3">
                  <span className="grid max-w-[24rem] min-w-0">
                    <span className="font-medium text-ink">{line.description}</span>
                    <span className="truncate text-caption text-ink-3">
                      {line.description !== defaultLineDescription(line) &&
                        `${variantName(line)} · `}
                      <span className="font-mono">{line.sku}</span>
                    </span>
                    {/* Decision 52: where the goods went, in the base unit like the batch */}
                    {line.batches.map((batch) => (
                      <span key={batch.batchId} className="text-caption text-ink-3 tabular-nums">
                        {t('posReturns.batches', {
                          lot: batch.lotNumber,
                          quantity: quantity(batch.quantity, line.baseUnitId),
                        })}
                      </span>
                    ))}
                    {line.serialNumbers.length > 0 && (
                      <span className="font-mono text-caption text-ink-3">
                        {t('posReturns.serials', { serials: line.serialNumbers.join(', ') })}
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {quantity(line.quantity, line.unitId)}
                  {line.unitId !== line.baseUnitId && (
                    <span className="block text-caption text-ink-3">
                      {t('stockLines.equals', {
                        quantity: quantity(line.baseQuantity, line.baseUnitId),
                      })}
                    </span>
                  )}
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {money(line.unitPrice)}
                </td>
                <td className="px-5 py-3 text-right font-medium whitespace-nowrap tabular-nums">
                  {money(item.pricesIncludeVat ? line.total : line.net)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* No discount row: what came back was already after its discounts */}
      <SalesTotals
        totals={{ discount: '0', net: item.net, vat: item.vat, total: item.total }}
        pricesIncludeVat={item.pricesIncludeVat}
      />
    </Card>
  );
}

// How the money went back, in the order the cashier typed it. An exchange is a row too, with the
// sale its money paid for (decision 1): the money did not leave the shop, it bought something else.
function RefundsCard({ item, money }: { item: PosReturn; money: (value: string) => string }) {
  const { t } = useLocale();
  return (
    <Card>
      <CardHeader title={t('posReturns.refunds')} />
      <dl className="grid gap-2 px-5 pt-3 pb-5 text-body-sm">
        {item.refunds.map((refund, index) => (
          <div key={`${String(index)}-${refund.method}`} className="flex justify-between gap-3">
            <dt className="text-ink-2">
              {t(`pos.methods.${refund.method}`)}
              {refund.reference !== null && (
                <span className="text-ink-3"> · {refund.reference}</span>
              )}
              {refund.method === 'exchange' && item.exchangeSale && (
                <span className="block text-caption">
                  <Link
                    to="/pos/sales/$saleId"
                    params={{ saleId: item.exchangeSale.id }}
                    className="font-medium text-brand underline-offset-3 hover:underline"
                  >
                    {t('posReturns.usedOn', { number: item.exchangeSale.number })}
                  </Link>
                </span>
              )}
            </dt>
            <dd className="tabular-nums">{money(refund.amount)}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-3 border-t border-line pt-2 font-medium">
          <dt>{t('posReturns.columns.total')}</dt>
          <dd className="tabular-nums">{money(item.total)}</dd>
        </div>
      </dl>
    </Card>
  );
}

// The slip, hidden on the screen, for Print. Its own component: useReceiptCompany is a hook, and
// the settings are only known to be there inside this branch (like the sale's page).
function ReprintSheet({
  item,
  register,
  units,
  settings,
}: {
  item: PosReturn;
  register: PosRegister;
  units: readonly Unit[];
  settings: Parameters<typeof useReceiptCompany>[0];
}) {
  const company = useReceiptCompany(settings);
  return <PosReturnSlip slip={slipOfReturn(item, register, units)} company={company} />;
}
