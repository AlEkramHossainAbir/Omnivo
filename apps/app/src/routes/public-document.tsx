import { Alert02Icon, Pdf01Icon, Unlink01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  isOutputDocument,
  type PublicDocument,
  routes,
  SHARE_LINK_DAYS,
  SHARE_TOKEN_PATTERN,
} from '@omnivo/contracts';
import { setLanguage, useLocale } from '@omnivo/i18n';
import { Button, Card, EmptyState, parseIsoDate } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { type ReactNode, useEffect } from 'react';

import { ApiRequestError, call } from '../lib/api';
import { saveFile } from '../lib/document-output';

// Step 16: the page behind a share link (/d/<token>). No login and no app shell: the customer is
// not an Omnivo user. It says what the document is and from whom, and downloads its PDF.

// While the PDF is being drawn the page asks again every 2 s, at most 15 times (30 s). After that
// it says the PDF could not be made: a worker that is down does not get better by being asked.
const POLL_MS = 2000;
const MAX_POLLS = 15;

function Frame({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  return (
    <div className="flex min-h-dvh flex-col bg-bg px-4 py-8 sm:px-16">
      <div className="grid flex-1 place-items-center py-10">
        <div className="w-full max-w-[480px]">{children}</div>
      </div>
      {/* The sender is the company; Omnivo only carries the file, so a quiet line, not the logo
          (the logo's own "Omnivo" next to "Sent with Omnivo" said the name twice) */}
      <footer className="text-center text-caption text-ink-3">
        {t('publicDocument.poweredBy')}
      </footer>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-caption font-medium text-ink-3">{label}</dt>
      <dd className="text-body-sm text-ink tabular-nums">{value}</dd>
    </div>
  );
}

function DocumentCard({
  shared,
  polls,
  onDownload,
  downloading,
}: {
  shared: PublicDocument;
  polls: number;
  onDownload: () => void;
  downloading: boolean;
}) {
  const { t, format } = useLocale();
  const date = (iso: string) => {
    const parsed = parseIsoDate(iso);
    return parsed ? format.date(parsed) : iso;
  };
  // ৳ is the app's sign for taka; another currency is written by its code, after the amount
  const money = (value: string) =>
    shared.currency === 'BDT'
      ? format.money(value, { decimals: 2 })
      : `${format.number(value, 2)} ${shared.currency}`;
  const name = isOutputDocument(shared.kind)
    ? t(`documentOutput.kinds.${shared.kind}`)
    : t('publicDocument.document');
  const { status } = shared.file;
  const gaveUp = status === 'failed' || (status === 'pending' && polls >= MAX_POLLS);

  return (
    <Card className="grid gap-6 p-[22px] sm:p-8">
      <header className="flex items-center gap-3">
        {shared.logoUrl !== null && (
          // The company's name sits next to it and says the same: an empty alt
          <img src={shared.logoUrl} alt="" className="h-10 w-auto max-w-28 object-contain" />
        )}
        <p className="text-label font-medium text-ink-2">
          {t('publicDocument.from', { company: shared.company })}
        </p>
      </header>
      <div className="grid gap-1">
        <h1 className="text-h1 text-balance">
          {name} {/* A number never breaks at its hyphens: on a phone "QT-" ended one line */}
          <span className="font-mono whitespace-nowrap tabular-nums">{shared.number}</span>
        </h1>
        <p className="text-body-sm text-ink-2">
          {t('publicDocument.to', { customer: shared.customer })}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
        <Fact label={t('publicDocument.date')} value={date(shared.date)} />
        <Fact label={t('publicDocument.total')} value={money(shared.total)} />
        {shared.dueDate !== null && (
          <Fact label={t('publicDocument.dueDate')} value={date(shared.dueDate)} />
        )}
        {shared.amountDue !== null && (
          <Fact label={t('publicDocument.amountDue')} value={money(shared.amountDue)} />
        )}
      </dl>
      {gaveUp ? (
        <p className="flex items-center gap-1.5 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {t('publicDocument.failed')}
        </p>
      ) : (
        <Button
          className="w-full"
          disabled={status !== 'ready' || downloading}
          onClick={onDownload}
        >
          <HugeiconsIcon icon={Pdf01Icon} size={17} strokeWidth={1.5} />
          {status === 'ready' ? t('publicDocument.download') : t('publicDocument.preparing')}
        </Button>
      )}
      <p className="text-label text-ink-3">{t('publicDocument.private')}</p>
    </Card>
  );
}

export function PublicDocumentPage() {
  const { t } = useLocale();
  const { token = '' } = useParams({ strict: false });
  // A token of the wrong shape cannot be a link: the page says "no longer works" without asking
  // the server (which would answer 400, not 404)
  const wellFormed = SHARE_TOKEN_PATTERN.test(token);
  const queryKey = ['public-document', token];
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: () => call(routes.publicDocuments.get, { params: { token } }),
    enabled: wellFormed,
    retry: false,
    refetchInterval: (current) =>
      current.state.data?.file.status === 'pending' && current.state.dataUpdateCount < MAX_POLLS
        ? POLL_MS
        : false,
  });
  const shared = query.data;

  // The page reads in the language the sender chose for the link, in this tab only: the customer
  // may use Omnivo in another language themselves (remember: false, 16.6)
  const language = shared?.language;
  useEffect(() => {
    if (language !== undefined) void setLanguage(language, { remember: false });
  }, [language]);

  // The tab's title names the sender: the customer may have three of these open
  useEffect(() => {
    if (!shared) return;
    const name = isOutputDocument(shared.kind)
      ? t(`documentOutput.kinds.${shared.kind}`)
      : t('publicDocument.document');
    document.title = t('publicDocument.pageTitle', {
      document: name,
      number: shared.number,
      company: shared.company,
    });
  }, [shared, t]);

  // Asks again before saving: the download link inside the answer is short-lived, and the
  // customer may tap the button long after the page loaded
  const download = async () => {
    const fresh = await query.refetch();
    if (fresh.data?.file.status === 'ready') saveFile(fresh.data.file);
  };

  const gone =
    !wellFormed ||
    (query.error instanceof ApiRequestError && query.error.code === 'share_link_not_found');

  return (
    <Frame>
      {gone ? (
        // One text for an unknown, an ended and a turned-off link (decision 14)
        <EmptyState
          icon={Unlink01Icon}
          title={t('publicDocument.goneTitle')}
          description={t('publicDocument.goneBody', { days: SHARE_LINK_DAYS })}
        />
      ) : query.isError ? (
        <div className="grid justify-items-center gap-4 text-center">
          <p className="text-body-sm text-crit">{t('publicDocument.loadFailed')}</p>
          <Button
            variant="secondary"
            onClick={() => {
              void query.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : shared ? (
        <DocumentCard
          shared={shared}
          // How many answers came so far: the state the refetchInterval above counts with
          polls={queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0}
          downloading={query.isFetching}
          onDownload={() => {
            void download();
          }}
        />
      ) : null}
    </Frame>
  );
}
