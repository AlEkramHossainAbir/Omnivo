import { routes, type SupplierRefund } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, cn, Dialog, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { accountsQuery, branchesQuery } from '../lib/queries';
import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { PrintButton, SupplierRefundPrint } from './print-documents';
import { PurchaseBackLink, SupplierLink } from './purchase-parts';
import { DocumentNotice } from './sales-parts';
import { DocumentStatusPill } from './sales-pills';
import { useIsoDate, useTenantId } from './stock-parts';

// "Void refund" is the supplier payment's void dialog (payment-dialogs.tsx), loaded when it opens
const PurchaseVoidForm = lazy(async () => ({
  default: (await import('./payment-dialogs')).PurchaseVoidForm,
}));

const LINK = 'font-medium text-brand underline-offset-3 hover:underline';

// A saved supplier refund, read only: it is posted the moment it is saved, like the customer's
// refund of 15d. Money that never came (the supplier's cheque bounced) is undone by "Void refund":
// its entry is reversed and the supplier owes the money again on its source. A voided one stays in
// the list with its number.
export function SupplierRefundView({ refund, today }: { refund: SupplierRefund; today: string }) {
  const { t, format } = useLocale();
  const isoDate = useIsoDate();
  const tenantId = useTenantId();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  const canWrite = useCan()('purchase.refund.manage');
  const [voiding, setVoiding] = useState(false);
  const money = (value: string) => format.money(value, { decimals: 2 });
  const posted = refund.status === 'posted';
  const account = accounts?.find((item) => item.id === refund.accountId);
  const sourceLabel = `${t(`supplierRefunds.sources.${refund.source.type}`)} ${refund.source.number}`;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/supplier-refunds" label={t('supplierRefunds.back')} />
      <PageHeader
        title={refund.number}
        description={refund.supplier.name}
        actions={
          <>
            <DocumentStatusPill
              status={refund.status}
              label={t(`supplierRefunds.statuses.${refund.status}`)}
            />
            {/* A voided refund does not print: on paper it would look like money received */}
            {posted && <PrintButton />}
          </>
        }
      />
      {refund.voidDate !== null && (
        <DocumentNotice tone="neutral">
          {t('supplierRefunds.voidedNotice', {
            date: isoDate(refund.voidDate),
            reason: refund.voidReason ?? '',
          })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">
            {t('supplierRefunds.supplier')}
          </span>
          <span className="text-body-sm">
            <SupplierLink supplier={refund.supplier} />
          </span>
        </div>
        <Fact label={t('supplierRefunds.date')} value={isoDate(refund.date)} />
        <Fact label={t('supplierRefunds.amount')} value={money(refund.amount)} />
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('supplierRefunds.source')}</span>
          {refund.source.type === 'debit_note' ? (
            <Link
              to="/debit-notes/$debitNoteId"
              params={{ debitNoteId: refund.source.id }}
              className={cn('text-body-sm', LINK)}
            >
              {sourceLabel}
            </Link>
          ) : (
            <Link
              to="/supplier-payments/$paymentId"
              params={{ paymentId: refund.source.id }}
              className={cn('text-body-sm', LINK)}
            >
              {sourceLabel}
            </Link>
          )}
        </div>
        <Fact label={t('supplierRefunds.method')} value={t(`receipts.methods.${refund.method}`)} />
        {refund.reference !== null && (
          <Fact label={t('supplierRefunds.reference')} value={refund.reference} />
        )}
        <Fact
          label={t('supplierRefunds.account')}
          value={account ? `${account.code} · ${account.name}` : '—'}
        />
        <Fact
          label={t('supplierRefunds.branch')}
          value={branches?.find((branch) => branch.id === refund.branchId)?.name ?? '—'}
        />
        <EntryLinks label={t('supplierRefunds.entry')} entries={[refund.entry]} none="" />
        {refund.voidEntry !== null && (
          <EntryLinks label={t('supplierRefunds.voidEntry')} entries={[refund.voidEntry]} none="" />
        )}
        {refund.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('supplierRefunds.note')} value={refund.note} />
          </div>
        )}
      </Card>

      {posted && canWrite && (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            onClick={() => {
              setVoiding(true);
            }}
          >
            {t('supplierRefunds.void')}
          </Button>
        </div>
      )}

      <Dialog open={voiding} onOpenChange={setVoiding}>
        <Suspense fallback={null}>
          {voiding && (
            <PurchaseVoidForm
              words="supplierRefunds"
              number={refund.number}
              version={refund.version}
              today={today}
              save={async (body) => {
                await call(routes.supplierRefunds.void, { params: { id: refund.id }, body });
              }}
              onDone={() => {
                setVoiding(false);
              }}
            />
          )}
        </Suspense>
      </Dialog>
      {posted && (
        <SupplierRefundPrint
          refund={refund}
          account={account ? `${account.code} · ${account.name}` : '—'}
        />
      )}
    </div>
  );
}
