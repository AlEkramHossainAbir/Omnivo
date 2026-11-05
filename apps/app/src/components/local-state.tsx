import {
  CloudDownloadIcon,
  CloudOffIcon,
  ComputerPhoneSyncIcon,
  ComputerRemoveIcon,
  HardDriveIcon,
  InformationCircleIcon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { Button, EmptyState } from '@omnivo/ui';
import { useEffect } from 'react';

import { checkForUpdate, reloadApp } from '../lib/app-update';
import { askForBranch, type LocalView, retryLocalData } from '../lib/local-data';

export type WaitingView = Exclude<LocalView, { kind: 'ready' }>;

// What the products and customers pages show instead of their list while the device has no
// complete copy (decisions 12, 40 and the states of 18a.5). Each says what to do, so nobody
// thinks the workspace lost its products.
// `actions={false}` inside another dialog (the product picker): its button would open the branch
// dialog on top of it
export function LocalState({ view, actions = true }: { view: WaitingView; actions?: boolean }) {
  const { t, format, errorText } = useLocale();
  switch (view.kind) {
    case 'loading':
      return null;
    case 'not-set-up':
      return (
        <EmptyState
          icon={ComputerPhoneSyncIcon}
          title={t('sync.notSetUpTitle')}
          description={t('sync.notSetUpBody')}
          action={actions && <Button onClick={askForBranch}>{t('sync.setUp')}</Button>}
        />
      );
    case 'first-pull':
      return (
        <EmptyState
          icon={CloudDownloadIcon}
          title={t('sync.firstPullTitle')}
          description={t('sync.firstPullBody')}
          action={
            // A live line: a screen reader hears the count grow without moving the focus
            <p role="status" className="text-caption text-ink-3 tabular-nums">
              {view.copied > 0 &&
                t('sync.firstPullCount', {
                  count: view.copied,
                  formatted: format.number(view.copied),
                })}
            </p>
          }
        />
      );
    case 'first-pull-failed':
      return (
        <EmptyState
          icon={CloudOffIcon}
          title={t('sync.firstPullFailedTitle')}
          description={t('sync.firstPullFailedBody')}
          action={
            actions && (
              <Button variant="secondary" onClick={retryLocalData}>
                {t('common.retry')}
              </Button>
            )
          }
        />
      );
    case 'offline-empty':
      return (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.offlineEmptyTitle')}
          description={t('sync.offlineEmptyBody')}
        />
      );
    case 'storage-failed':
      return (
        <EmptyState
          icon={HardDriveIcon}
          title={t('sync.storageFailedTitle')}
          description={t('sync.storageFailedBody')}
        />
      );
    case 'revoked':
      return (
        <EmptyState
          icon={ComputerRemoveIcon}
          title={t('sync.revokedTitle')}
          description={errorText('device_revoked')}
        />
      );
  }
}

// The one line a picker can show in its list (the Combobox has no room for a button)
export function useLocalStateText(): (view: WaitingView) => string | undefined {
  const { t } = useLocale();
  return (view) => {
    switch (view.kind) {
      case 'loading':
        return undefined;
      case 'not-set-up':
        return t('sync.notSetUpTitle');
      case 'first-pull':
        return t('sync.firstPullTitle');
      case 'first-pull-failed':
        return t('sync.firstPullFailedTitle');
      case 'offline-empty':
        return t('sync.offlineEmptyTitle');
      case 'storage-failed':
        return t('sync.storageFailedTitle');
      case 'revoked':
        return t('sync.revokedTitle');
    }
  };
}

// A problem of the engine that needs the person (local-data.ts → NOTICES, all error codes): above the list, which
// still shows the copy. Like a document notice (CLAUDE.md), neutral: the data is still there.
// Step 19a: the app is older than the server (sync_protocol_mismatch) right after a new version was
// published, so the notice asks the service worker to look for it at once: by the time the person
// reads this, it is often waiting, and Reload takes it. A plain reload would open the old version
// again, from the worker's files.
export function SyncNotice({ code }: { code: string }) {
  const { t, errorText } = useLocale();
  useEffect(() => {
    if (code === 'sync_protocol_mismatch') checkForUpdate();
  }, [code]);
  return (
    <p className="flex items-start gap-2 rounded-control border border-line bg-subtle px-3 py-2.5 text-body-sm text-ink-2">
      <HugeiconsIcon
        icon={InformationCircleIcon}
        size={17}
        strokeWidth={1.5}
        className="mt-px shrink-0"
      />
      <span>
        {errorText(code)}{' '}
        <button
          type="button"
          className="font-medium text-brand underline-offset-3 hover:underline"
          onClick={reloadApp}
        >
          {t('common.reload')}
        </button>
      </span>
    </p>
  );
}
