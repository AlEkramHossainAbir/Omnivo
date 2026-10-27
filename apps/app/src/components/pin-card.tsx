import { Alert02Icon, CheckmarkCircle02Icon, SquareUnlock02Icon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { MAX_WRONG_PINS } from '@omnivo/sync';
import { Button, Card, CardHeader, Pill } from '@omnivo/ui';

import { askForPin, useKeyStatus } from '../lib/local-data';

// Step 19b (decision 5): the Sync page's card about the device PIN. "Stopped working" is warn: the
// person must set a new one before working offline again. "No PIN" is neutral: the data still
// opens online, and the card says what a PIN adds.
export function PinCard() {
  const { t, format } = useLocale();
  // null while no copy is open: nothing to set a PIN on
  const status = useKeyStatus();
  if (!status) return null;
  const max = format.number(MAX_WRONG_PINS);

  return (
    <Card>
      <CardHeader
        title={t('pin.card.title')}
        subtitle={t('pin.card.subtitle')}
        actions={
          status.hasPin ? (
            <Pill tone="good" icon={CheckmarkCircle02Icon}>
              {t('pin.card.on')}
            </Pill>
          ) : status.pinBlocked ? (
            <Pill tone="warn" icon={Alert02Icon}>
              {t('pin.card.blocked')}
            </Pill>
          ) : (
            <Pill tone="neutral" icon={SquareUnlock02Icon}>
              {t('pin.card.off')}
            </Pill>
          )
        }
      />
      <div className="grid gap-3 px-5 pt-3 pb-5">
        <p className="text-body-sm text-ink-2">
          {status.hasPin
            ? t('pin.card.onBody')
            : status.pinBlocked
              ? t('pin.card.blockedBody', { max })
              : t('pin.card.offBody')}
        </p>
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              askForPin(status.hasPin ? 'change' : status.pinBlocked ? 'new' : 'set-up');
            }}
          >
            {status.hasPin ? t('pin.card.change') : t('pin.card.set')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
