import { type Refund, routes } from '@omnivo/contracts';
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
import { PrintButton, RefundPrint } from './print-documents';
import { CustomerLink, DocumentNotice, SalesBackLink } from './sales-parts';
import { DocumentStatusPill } from './sales-pills';
import { useIsoDate, useTenantId } from './stock-parts';

// "Void refund" is the receipt's void dialog (money-dialogs.tsx), loaded when it opens
const VoidForm = lazy(async () => ({ default: (await import('./money-dialogs')).VoidForm }));

const LINK = 'font-medium text-brand underline-offset-3 hover:underline';

// A saved refund, read only: it is posted the moment it is saved. Money that never reached the
// customer (a cheque that came back) is undone by "Void refund": its entry is reversed and the
// money is the source's advance again. A voided one stays in the list with its number.
export function RefundView({ refund, today }: { refund: Refund; today: string }) {
  const { t, format } = useLocale();
  const isoDate = useIsoDate();
  const tenantId = useTenantId();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  const canWrite = useCan()('sales.refund.manage');
  const [voiding, setVoiding] = useState(false);
  const money = (value: string) => format.money(value, { decimals: 2 });
  const posted = refund.status === 'posted';
  const account = accounts?.find((item) => item.id === refund.accountId);
  const sourceLabel = `${t(`refunds.sources.${refund.source.type}`)} ${refund.source.number}`;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/refunds" label={t('refunds.back')} />
      <PageHeader
        title={refund.number}
        description={refund.customer.name}
        actions={
          <>
            <DocumentStatusPill
              status={refund.status}
              label={t(`refunds.statuses.${refund.status}`)}
            />
            {/* A voided refund does not print: on paper it would look like money handed over */}
            {posted && <PrintButton />}
          </>
        }
      />
      {refund.voidDate !== null && (
        <DocumentNotice tone="neutral">
          {t('refunds.voidedNotice', {
            date: isoDate(refund.voidDate),
            reason: refund.voidReason ?? '',
          })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('refunds.customer')}</span>
          <span className="text-body-sm">
            <CustomerLink customer={refund.customer} />
          </span>
        </div>
        <Fact label={t('refunds.date')} value={isoDate(refund.date)} />
        <Fact label={t('refunds.amount')} value={money(refund.amount)} />
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('refunds.source')}</span>
          {refund.source.type === 'receipt' ? (
            <Link
              to="/receipts/$receiptId"
              params={{ receiptId: refund.source.id }}
              className={cn('text-body-sm', LINK)}
            >
              {sourceLabel}
            </Link>
          ) : (
            <Link
              to="/credit-notes/$creditNoteId"
              params={{ creditNoteId: refund.source.id }}
              className={cn('text-body-sm', LINK)}
            >
              {sourceLabel}
            </Link>
          )}
        </div>
        <Fact label={t('refunds.method')} value={t(`receipts.methods.${refund.method}`)} />
        {refund.reference !== null && (
          <Fact label={t('refunds.reference')} value={refund.reference} />
        )}
        <Fact
          label={t('refunds.account')}
          value={account ? `${account.code} · ${account.name}` : '—'}
        />
        <Fact
          label={t('refunds.branch')}
          value={branches?.find((branch) => branch.id === refund.branchId)?.name ?? '—'}
        />
        <EntryLinks label={t('refunds.entry')} entries={[refund.entry]} none="" />
        {refund.voidEntry !== null && (
          <EntryLinks label={t('refunds.voidEntry')} entries={[refund.voidEntry]} none="" />
        )}
        {refund.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('refunds.note')} value={refund.note} />
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
            {t('refunds.void')}
          </Button>
        </div>
      )}

      <Dialog open={voiding} onOpenChange={setVoiding}>
        <Suspense fallback={null}>
          {voiding && (
            <VoidForm
              words="refunds"
              number={refund.number}
              version={refund.version}
              today={today}
              save={async (body) => {
                await call(routes.refunds.void, { params: { id: refund.id }, body });
              }}
              onDone={() => {
                setVoiding(false);
              }}
            />
          )}
        </Suspense>
      </Dialog>
      {posted && <RefundPrint refund={refund} />}
    </div>
  );
}
