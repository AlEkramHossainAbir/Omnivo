import {
  Alert02Icon,
  ArrowReloadHorizontalIcon,
  CloudSavingDone01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import {
  dependentsOf,
  discardEntry,
  dismissNotice,
  isOpen,
  type OutboxEntry,
  outboxEntries,
  readPullState,
  retryEntry,
  syncNotices,
} from '@omnivo/sync';
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  PageHeader,
  toast,
} from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { LocalState } from '../components/local-state';
import { useTenantId, useTimeZone } from '../components/stock-parts';
import { OutboxStatusPill, useCommandText, useFieldList } from '../components/sync-parts';
import {
  requestSync,
  useLocalData,
  useLocalDb,
  useLocalQuery,
  useSyncStatus,
} from '../lib/local-data';
import { useOnline } from '../lib/use-online';

// Step 18b (decision 1): the work saved on this device, oldest first, as the push sends it; what
// the server kept from a change; and when the device last synced. Retry, Edit and Discard per
// change, and "Sync now".

// The earlier command an entry waits for (decision 13): one on the same customer still on the
// device. Only a waiting entry waits; a refused one says why it was refused instead.
function waitsFor(entries: readonly OutboxEntry[], entry: OutboxEntry): OutboxEntry | undefined {
  if (entry.status !== 'waiting' || entry.seq === undefined) return undefined;
  const { seq } = entry;
  return entries.find((other) => other.customerId === entry.customerId && (other.seq ?? 0) < seq);
}

// Where Edit opens a command: the customer's form, or the order's
function EditLink({ entry }: { entry: OutboxEntry }) {
  const { t } = useLocale();
  const className =
    'inline-flex min-h-9 items-center rounded-control border border-line-strong bg-surface px-3 text-body-sm font-medium text-ink shadow-sm transition-colors duration-150 hover:bg-subtle';
  return entry.command.type === 'sales_order.create_draft' ? (
    <Link to="/sales-orders/$orderId" params={{ orderId: entry.key }} className={className}>
      {t('sync.edit')}
    </Link>
  ) : (
    <Link
      to="/customers/$customerId/edit"
      params={{ customerId: entry.customerId }}
      className={className}
    >
      {t('sync.edit')}
    </Link>
  );
}

export function SyncPage() {
  const { t, format, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const online = useOnline();
  const timeZone = useTimeZone();
  const { view } = useLocalData();
  const status = useSyncStatus();
  const db = useLocalDb();
  const entries = useLocalQuery(db ? outboxEntries : null);
  const notices = useLocalQuery(db ? syncNotices : null);
  const pull = useLocalQuery(readPullState);
  const commandText = useCommandText();
  const fieldList = useFieldList();
  const [discarding, setDiscarding] = useState<OutboxEntry | null>(null);
  const dependents = discarding && entries ? dependentsOf(entries, discarding).length : 0;

  const retry = async (entry: OutboxEntry) => {
    if (!db || entry.seq === undefined) return;
    await retryEntry(db, entry.seq);
    requestSync();
  };

  const discard = async (entry: OutboxEntry) => {
    if (!db || entry.seq === undefined) return;
    const result = await discardEntry(db, entry.seq);
    setDiscarding(null);
    if (result === 'busy') {
      toast(t('sync.busy'));
      return;
    }
    // A customer made here leaves the lists and the pickers
    await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
    toast(t('sync.discarded'));
  };

  const lastSync = pull?.lastSyncAt ?? null;

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader
        title={t('sync.title')}
        description={t('sync.description')}
        actions={
          <Button
            disabled={!online || !db || status.syncing}
            onClick={() => {
              requestSync();
            }}
          >
            <HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={17} strokeWidth={1.5} />
            {status.syncing ? t('sync.syncing') : t('sync.syncNow')}
          </Button>
        }
      />
      <p className="text-body-sm text-ink-2 tabular-nums">
        {lastSync === null
          ? t('sync.neverSynced')
          : t('sync.lastSynced', { time: format.dateTime(new Date(lastSync), timeZone) })}
        {!online && ` · ${t('sync.syncNowOffline')}`}
      </p>

      {!db && view.kind !== 'ready' && <LocalState view={view} />}

      {notices && notices.length > 0 && (
        <Card>
          <CardHeader title={t('sync.noticesTitle')} subtitle={t('sync.noticesSubtitle')} />
          <ul className="mt-4 divide-y divide-line border-t border-line">
            {notices.map((notice) => (
              <li
                key={notice.commandId}
                className="flex flex-wrap items-start justify-between gap-3 px-5 py-3"
              >
                <span className="grid min-w-0">
                  <span className="text-body-sm font-medium">{notice.name}</span>
                  <span className="text-caption text-ink-3">
                    {t('sync.keptFields', { fields: fieldList(notice.fields) })}
                  </span>
                </span>
                <button
                  type="button"
                  className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
                  onClick={() => {
                    if (db) void dismissNotice(db, notice.commandId);
                  }}
                >
                  {t('sync.dismiss')}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {entries && (
        <Card>
          <CardHeader title={t('sync.changesTitle')} subtitle={t('sync.changesSubtitle')} />
          {entries.length === 0 ? (
            <div className="py-6">
              <EmptyState
                icon={CloudSavingDone01Icon}
                title={t('sync.emptyTitle')}
                description={t('sync.emptyBody')}
              />
            </div>
          ) : (
            <ul className="mt-4 divide-y divide-line border-t border-line">
              {entries.map((entry) => {
                const text = commandText(entry);
                const before = waitsFor(entries, entry);
                return (
                  <li
                    key={entry.seq}
                    className="grid grid-cols-1 gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <div className="grid min-w-0 content-start gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-body-sm font-medium">{text.title}</span>
                        <OutboxStatusPill status={entry.status} />
                      </span>
                      <span className="text-caption text-ink-3 tabular-nums">
                        {[
                          t('sync.savedAt', {
                            time: format.dateTime(new Date(entry.savedAt), timeZone),
                          }),
                          text.detail,
                        ]
                          .filter((part) => part !== '')
                          .join(' · ')}
                      </span>
                      {before && (
                        <span className="text-caption text-ink-2">
                          {t('sync.waitsFor', { name: before.name })}
                        </span>
                      )}
                      {entry.status === 'failed' && entry.error && (
                        <span className="flex items-start gap-1.5 text-label text-crit">
                          <HugeiconsIcon
                            icon={Alert02Icon}
                            size={15}
                            strokeWidth={1.5}
                            className="mt-px shrink-0"
                          />
                          <span>
                            {errorText(entry.error.code)} {t('sync.fixHint')}
                          </span>
                        </span>
                      )}
                    </div>
                    {/* Nothing to do with a command on its way: its answer decides */}
                    {entry.status !== 'sending' && (
                      <div className="flex flex-wrap items-start gap-2 sm:justify-end">
                        {isOpen(entry) && <EditLink entry={entry} />}
                        {entry.status === 'failed' && (
                          <Button variant="secondary" size="sm" onClick={() => void retry(entry)}>
                            {t('common.retry')}
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setDiscarding(entry);
                          }}
                        >
                          {t('sync.discard')}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      <Dialog
        open={discarding !== null}
        onOpenChange={(open) => {
          if (!open) setDiscarding(null);
        }}
      >
        {discarding && (
          <DialogContent
            title={t('sync.discardTitle')}
            description={commandText(discarding).title}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">{t('common.cancel')}</Button>
                </DialogClose>
                <Button onClick={() => void discard(discarding)}>{t('sync.discardConfirm')}</Button>
              </>
            }
          >
            <p className="text-body-sm text-ink-2">
              {t('sync.discardBody')}
              {dependents > 0 &&
                ` ${t('sync.discardDependents', {
                  count: dependents,
                  formatted: format.number(dependents),
                })}`}
            </p>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
