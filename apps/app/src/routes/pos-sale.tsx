import { Alert02Icon, AlertCircleIcon, PrinterIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  addMoney,
  compareQuantity,
  isZeroMoney,
  multiplyMoney,
  type PosRegister,
  type PosSale,
  subtractMoney,
  todayIn,
  type Unit,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, EmptyState, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { Fact } from '../components/adjustment-view';
import { DocumentNotice } from '../components/document-notice';
import { EntryLinks } from '../components/entry-links';
import { useReceiptCompany } from '../components/pos-parts';
import { PosSalePills } from '../components/pos-sale-parts';
import { SalesBackLink } from '../components/sales-parts';
import { SalesLinesTable } from '../components/sales-lines-table';
import {
  useIsoDate,
  useQuantity,
  useTenantId,
  useTimeZone,
  useWarehouses,
  warehouseLabel,
} from '../components/stock-parts';
import type { ReceiptData } from '../lib/pos';
import { posRegisterQuery, posSaleQuery } from '../lib/pos-queries';
import { settingsQuery, unitsQuery } from '../lib/queries';
import { useOnline } from '../lib/use-online';

// Step 20a: one POS sale, as the server posted it: its lines with the batches and serial numbers
// they left with, what went below zero, the payments, and its journal entry. "Print receipt" prints
// the same thermal receipt the counter printed (a customer who lost it).

const PosReceipt = lazy(async () => ({
  default: (await import('../components/pos-receipt')).PosReceipt,
}));

// The receipt from the server's sale. A line's amount on the receipt is after its own discount
// and before the bill's share: the server's net or total (whichever the prices are written in)
// plus that share. Its own discount is the rest of quantity × price.
function receiptOfSale(
  sale: PosSale,
  register: Pick<PosRegister, 'paperWidth' | 'receiptFooter'>,
  units: readonly Unit[],
): ReceiptData {
  return {
    number: sale.number,
    soldAt: sale.soldAt,
    registerCode: sale.register.code,
    paperWidth: register.paperWidth,
    receiptFooter: register.receiptFooter,
    cashier: sale.cashier.fullName,
    customerName: sale.customer?.name ?? null,
    lines: sale.lines.map((line) => {
      const unit = units.find((one) => one.id === line.unitId);
      const after = addMoney(sale.pricesIncludeVat ? line.total : line.net, line.billDiscount);
      return {
        key: line.id,
        name: line.description,
        quantity: line.quantity,
        decimals: unit?.decimals ?? 0,
        unitCode: unit?.code ?? '',
        unitPrice: line.unitPrice,
        discount: subtractMoney(multiplyMoney(line.quantity, line.unitPrice), after),
        after,
      };
    }),
    pricesIncludeVat: sale.pricesIncludeVat,
    billDiscount: sale.billDiscountAmount,
    net: sale.net,
    vat: sale.vat,
    total: sale.total,
    payments: sale.payments,
    paid: sale.paid,
    change: sale.change,
  };
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/pos/sales" label={t('posSales.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('posSales.title')} description={message} />
    </div>
  );
}

export function PosSalePage() {
  const { t } = useLocale();
  const online = useOnline();
  const { saleId = '' } = useParams({ strict: false });
  const { data: sale, isError } = useQuery({
    ...posSaleQuery(useTenantId(), saleId),
    enabled: saleId !== '',
  });
  if (isError) return <CantFind message={t('posSales.notFound')} />;
  // Offline before it ever loaded: the sales are read from the server only
  if (!sale) return online ? null : <CantFind message={t('posSales.needsConnection')} />;
  return <PosSaleView sale={sale} />;
}

function PosSaleView({ sale }: { sale: PosSale }) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const warehouses = useWarehouses();
  const register = useQuery(posRegisterQuery(tenantId, sale.register.id)).data;
  const units = useQuery(unitsQuery(tenantId)).data;
  const settings = useQuery(settingsQuery(tenantId)).data;
  const money = (value: string) => format.money(value, { decimals: 2 });
  // Decision 26: the day it was sold, by the device, against the day it is in the books. They
  // differ when that day was closed (or the device's clock was ahead): the page says why.
  const soldOn = todayIn(timeZone, new Date(sale.soldAt));
  const warehouse = warehouseLabel(warehouses.byId.get(sale.warehouseId));

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/pos/sales" label={t('posSales.back')} />
      <PageHeader
        title={sale.number}
        description={sale.customer?.name ?? t('posSales.walkIn')}
        actions={
          <>
            <PosSalePills soldShort={sale.soldShort} />
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
                {t('posSales.print')}
              </Button>
            )}
          </>
        }
      />
      {soldOn !== sale.date && (
        <DocumentNotice tone="neutral">
          {t('posSales.bookedLater', { sold: isoDate(soldOn), date: isoDate(sale.date) })}
        </DocumentNotice>
      )}
      {sale.soldShort && (
        <DocumentNotice tone="warn" icon={Alert02Icon}>
          {t('posSales.soldShortNotice', { warehouse })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <Fact label={t('posSales.customer')} value={sale.customer?.name ?? t('posSales.walkIn')} />
        <Fact label={t('posSales.columns.date')} value={isoDate(sale.date)} />
        <Fact
          label={t('posSales.soldAt')}
          value={format.dateTime(new Date(sale.soldAt), timeZone)}
        />
        <Fact
          label={t('posSales.register')}
          value={`${sale.register.code} · ${sale.register.name}`}
        />
        <Fact label={t('posSales.cashier')} value={sale.cashier.fullName} />
        <Fact label={t('posSales.device')} value={sale.device.name} />
        <EntryLinks label={t('posSales.entry')} entries={sale.entry ? [sale.entry] : []} none="—" />
      </Card>
      <SalesLinesTable
        lines={sale.lines}
        totals={{ discount: sale.discount, net: sale.net, vat: sale.vat, total: sale.total }}
        pricesIncludeVat={sale.pricesIncludeVat}
        // Under the item: the batches it left from, its serial numbers, and what went below zero
        note={(line) => (
          <>
            {line.batches.map((batch) => (
              <span key={batch.batchId} className="text-caption text-ink-3 tabular-nums">
                {t('posSales.batches', {
                  lot: batch.lotNumber,
                  quantity: quantity(batch.quantity, line.baseUnitId),
                })}
              </span>
            ))}
            {line.serialNumbers.length > 0 && (
              <span className="font-mono text-caption text-ink-3">
                {t('posSales.serials', { serials: line.serialNumbers.join(', ') })}
              </span>
            )}
            {compareQuantity(line.shortQuantity, '0') > 0 && (
              <span className="text-caption font-medium text-warn">
                {t('posSales.shortLine', {
                  quantity: quantity(line.shortQuantity, line.baseUnitId),
                })}
              </span>
            )}
          </>
        )}
      />
      <Card>
        <CardHeader title={t('posSales.payments')} />
        <dl className="grid gap-2 px-5 pt-3 pb-5 text-body-sm">
          {sale.payments.map((payment, index) => (
            <div key={`${String(index)}-${payment.method}`} className="flex justify-between gap-3">
              <dt className="text-ink-2">
                {t(`pos.methods.${payment.method}`)}
                {payment.reference !== null && (
                  <span className="text-ink-3"> · {payment.reference}</span>
                )}
              </dt>
              <dd className="tabular-nums">{money(payment.amount)}</dd>
            </div>
          ))}
          {!isZeroMoney(sale.billDiscountAmount) && (
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">{t('pos.receipt.billDiscount')}</dt>
              <dd className="tabular-nums">−{money(sale.billDiscountAmount)}</dd>
            </div>
          )}
          <div className="flex justify-between gap-3 border-t border-line pt-2 font-medium">
            <dt>{t('posSales.paid')}</dt>
            <dd className="tabular-nums">{money(sale.paid)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-2">{t('posSales.change')}</dt>
            <dd className="tabular-nums">{money(sale.change)}</dd>
          </div>
        </dl>
      </Card>
      {register && units && settings && (
        <Suspense fallback={null}>
          <ReprintSheet sale={sale} register={register} units={units} settings={settings} />
        </Suspense>
      )}
    </div>
  );
}

// The receipt, hidden on the screen, for Print. Its own component: useReceiptCompany is a hook,
// and the settings are only known to be there inside this branch.
function ReprintSheet({
  sale,
  register,
  units,
  settings,
}: {
  sale: PosSale;
  register: PosRegister;
  units: readonly Unit[];
  settings: Parameters<typeof useReceiptCompany>[0];
}) {
  const company = useReceiptCompany(settings);
  return <PosReceipt receipt={receiptOfSale(sale, register, units)} company={company} />;
}
