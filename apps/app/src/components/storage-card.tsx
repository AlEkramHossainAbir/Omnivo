import { Alert02Icon, CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, Pill } from '@omnivo/ui';
import { useEffect, useState } from 'react';

import { askToKeep, readStorage, type StorageInfo } from '../lib/storage';

// Step 19a: the Sync page's card about the space the device uses. "May be cleared" is warn: the
// person can act on it (ask, or install the app), and what is at stake is work not synced yet.
export function StorageCard() {
  const { t, format } = useLocale();
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [asking, setAsking] = useState(false);
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    let live = true;
    void readStorage().then((read) => {
      if (live) setInfo(read);
    });
    return () => {
      live = false;
    };
  }, []);

  const ask = async () => {
    setAsking(true);
    const kept = await askToKeep();
    // false = asked and refused; null = this browser cannot be asked, which `unknown` already says
    setRefused(kept === false);
    setInfo(await readStorage());
    setAsking(false);
  };

  // The browser answers in a few milliseconds: a card that waits for it is better than one that
  // shows a wrong state first
  if (!info) return null;

  return (
    <Card>
      <CardHeader
        title={t('sync.storage.title')}
        subtitle={t('sync.storage.subtitle')}
        actions={
          info.kept === 'kept' ? (
            <Pill tone="good" icon={CheckmarkCircle02Icon}>
              {t('sync.storage.kept')}
            </Pill>
          ) : info.kept === 'may-be-cleared' ? (
            <Pill tone="warn" icon={Alert02Icon}>
              {t('sync.storage.mayBeCleared')}
            </Pill>
          ) : null
        }
      />
      <div className="grid gap-3 px-5 pt-3 pb-5">
        <p className="text-body-sm text-ink-2">
          {info.kept === 'kept'
            ? t('sync.storage.keptBody')
            : info.kept === 'may-be-cleared'
              ? t('sync.storage.mayBeClearedBody')
              : t('sync.storage.unknown')}
        </p>
        {info.used !== null && info.quota !== null && (
          <p className="text-caption text-ink-3 tabular-nums">
            {t('sync.storage.used', {
              used: format.bytes(info.used),
              quota: format.bytes(info.quota),
            })}
          </p>
        )}
        {info.kept === 'may-be-cleared' &&
          (refused ? (
            <p className="text-body-sm text-ink-2">{t('sync.storage.refused')}</p>
          ) : (
            <div>
              <Button variant="secondary" size="sm" disabled={asking} onClick={() => void ask()}>
                {t('sync.storage.ask')}
              </Button>
            </div>
          ))}
      </div>
    </Card>
  );
}
