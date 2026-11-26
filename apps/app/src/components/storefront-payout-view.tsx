import { compareMoney, type Payout, routes, subtractMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, Dialog, PageHeader } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { accountsQuery, branchesQuery } from '../lib/queries';
import { useTenantId } from '../lib/workspace';
import { Fact } from './adjustment-view';
import { DocumentNotice } from './document-notice';
import { EntryLinks } from './entry-links';
import { PayoutPrint, PrintButton } from './print-documents';
import { useIsoDate } from './stock-parts';
import { PayoutBackLink, PayoutStatusPill } from './storefront-payout-parts';

// Step 28c: a payout's page (approved with the mockup), laid out like a money receipt's: the
// number with the courier account under it, the pill and Print voucher; a voided payout's notice;
// the facts card with its entries; the parcels it paid, each with its receipt and its order; Void
// at the bottom, pushed left. Its own chunk, loaded by routes/storefront-payout.tsx.

const VoidForm = lazy(async () => ({ default: (await import('./money-dialogs')).VoidForm }));

const LINK = 'font-mono font-medium text-brand underline-offset-3 hover:underline';

export function PayoutView({ payout, today }: { payout: Payout; today: string }) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  // A line's order is a link only for someone who may open it: an accountant with only
  // storefront.payout.manage would get a refusal
  const canOrders = useCan()('storefront.order.read');
  // Reading the chart and the branches needs no permission (step 10): the facts name the accounts
  // the payout saved by id, archived ones too
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  const [voiding, setVoiding] = useState(false);
  const money = (value: string) => format.money(value, { decimals: 2 });
  const posted = payout.status === 'posted';
  const accountLabel = (id: string | null): string => {
    if (id === null) return '—';
    const account = accounts?.find((item) => item.id === id);
    return account ? `${account.code} · ${account.name}` : '—';
  };
  const courier = t(`storefront.couriers.names.${payout.account.courier}`);

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PayoutBackLink />
      <PageHeader
        title={payout.number}
        description={payout.account.name}
        actions={
          <>
            <PayoutStatusPill status={payout.status} />
            {/* A voided payout does not print (a voided document on paper looks real) */}
            {posted && <PrintButton label={t('storefront.payout.print')} />}
          </>
        }
      />
      {payout.voidDate !== null && (
        <DocumentNotice tone="neutral">
          {t('storefront.payout.voidedNotice', {
            date: isoDate(payout.voidDate),
            reason: payout.voidReason ?? '',
          })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <Fact label={t('storefront.payout.facts.account')} value={payout.account.name} />
        <Fact label={t('storefront.payout.facts.date')} value={isoDate(payout.date)} />
        <Fact label={t('storefront.payout.facts.reference')} value={payout.reference ?? '—'} />
        <Fact
          label={t('storefront.payout.facts.bankAccount')}
          value={accountLabel(payout.bankAccountId)}
        />
        <Fact
          label={t('storefront.payout.facts.codAccount')}
          value={accountLabel(payout.codAccountId)}
        />
        {payout.chargeAccountId !== null && (
          <Fact
            label={t('storefront.payout.facts.chargeAccount')}
            value={accountLabel(payout.chargeAccountId)}
          />
        )}
        <Fact
          label={t('storefront.payout.facts.branch')}
          value={branches?.find((branch) => branch.id === payout.branchId)?.name ?? '—'}
        />
        <EntryLinks label={t('storefront.payout.entry')} entries={[payout.entry]} none="" />
        {payout.voidEntry !== null && (
          <EntryLinks
            label={t('storefront.payout.voidEntry')}
            entries={[payout.voidEntry]}
            none=""
          />
        )}
        {payout.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('storefront.payout.facts.note')} value={payout.note} />
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title={t('storefront.payout.linesTitle')}
          subtitle={t('storefront.payout.linesDescription')}
        />
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-body-sm">
            <caption className="sr-only">{t('storefront.payout.linesTitle')}</caption>
            <thead>
              <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
                <th scope="col" className="px-5 py-2.5">
                  {t('storefront.payout.columns.parcel')}
                </th>
                <th scope="col" className="px-3 py-2.5">
                  {t('storefront.payout.columns.receipt')}
                </th>
                <th scope="col" className="px-3 py-2.5 text-right">
                  {t('storefront.payout.columns.collected')}
                </th>
                <th scope="col" className="px-3 py-2.5 text-right">
                  {t('storefront.payout.columns.charge')}
                </th>
                <th scope="col" className="px-5 py-2.5 text-right">
                  {t('storefront.payout.columns.net')}
                </th>
              </tr>
            </thead>
            <tbody>
              {payout.lines.map((line) => (
                <tr key={line.shipmentId} className="border-t border-line align-top">
                  <td className="px-5 py-3">
                    {canOrders ? (
                      <Link
                        to="/storefront/orders/$orderId"
                        params={{ orderId: line.order.id }}
                        className={LINK}
                      >
                        {line.invoice}
                      </Link>
                    ) : (
                      <span className="font-mono font-medium">{line.invoice}</span>
                    )}
                    <span className="block text-caption text-ink-3">
                      {t(`storefront.payout.kinds.${line.kind}`)}
                    </span>
                    {line.trackingCode !== null && (
                      <span className="block font-mono text-caption text-ink-3">
                        {line.trackingCode}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {line.receipt === null ? (
                      <span className="text-ink-3">—</span>
                    ) : (
                      <Link
                        to="/receipts/$receiptId"
                        params={{ receiptId: line.receipt.id }}
                        className={LINK}
                      >
                        {line.receipt.number ?? '—'}
                      </Link>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">
                    {money(line.collected)}
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">
                    {money(line.charge)}
                    {/* A charge the member changed (a file's, or the difference the courier
                        kept) shows the courier's own figure under it */}
                    {line.courierCharge !== null &&
                      compareMoney(line.courierCharge, line.charge) !== 0 && (
                        <span className="block text-caption text-ink-3">
                          {t('storefront.payout.courierSaid', {
                            courier,
                            amount: money(line.courierCharge),
                          })}
                        </span>
                      )}
                  </td>
                  <td className="px-5 py-3 text-right font-medium whitespace-nowrap tabular-nums">
                    {money(subtractMoney(line.collected, line.charge))}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line bg-subtle font-medium tabular-nums">
                <th scope="row" className="px-5 py-3 text-left">
                  {t('storefront.payout.total')}
                </th>
                <td />
                <td className="px-3 py-3 text-right whitespace-nowrap">
                  {money(payout.collected)}
                </td>
                <td className="px-3 py-3 text-right whitespace-nowrap">{money(payout.charges)}</td>
                <td className="px-5 py-3 text-right whitespace-nowrap">{money(payout.net)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      {posted && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Away from everything else: voiding can't be undone */}
          <Button
            variant="secondary"
            onClick={() => {
              setVoiding(true);
            }}
          >
            {t('storefront.payout.void')}
          </Button>
        </div>
      )}

      <Dialog open={voiding} onOpenChange={setVoiding}>
        <Suspense fallback={null}>
          {voiding && (
            <VoidForm
              words="storefront.payout"
              number={payout.number}
              version={payout.version}
              today={today}
              save={async (body) => {
                await call(routes.storefrontPayouts.void, { params: { id: payout.id }, body });
                // The parcels are free again: the couriers' Holds, the order pages and the list
                await Promise.all([
                  queryClient.invalidateQueries({ queryKey: ['storefront', tenantId] }),
                  queryClient.invalidateQueries({ queryKey: ['journal', tenantId] }),
                ]);
              }}
              onDone={() => {
                setVoiding(false);
              }}
            />
          )}
        </Suspense>
      </Dialog>
      {posted && <PayoutPrint payout={payout} bankAccount={accountLabel(payout.bankAccountId)} />}
    </div>
  );
}
