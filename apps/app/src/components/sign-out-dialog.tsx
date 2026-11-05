import { useLocale } from '@omnivo/i18n';
import { Button, Dialog, DialogClose, DialogContent } from '@omnivo/ui';

import { logout } from '../lib/session';

// Signing out deletes the device's copy, and the outbox with it (18a, decision 41): with changes
// still on the device, the person is asked first
export function SignOutDialog({ count, onClose }: { count: number; onClose: () => void }) {
  const { t, format } = useLocale();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        title={t('sync.signOutTitle')}
        footer={
          <>
            {/* The way that loses work is the secondary one, pushed left (CLAUDE.md → Dialog) */}
            <Button
              variant="secondary"
              className="mr-auto"
              onClick={() => {
                onClose();
                void logout();
              }}
            >
              {t('sync.signOutAnyway')}
            </Button>
            <DialogClose asChild>
              <Button>{t('sync.stay')}</Button>
            </DialogClose>
          </>
        }
      >
        <p className="text-body-sm text-ink-2">
          {t('sync.signOutBody', { count, formatted: format.number(count) })}
        </p>
      </DialogContent>
    </Dialog>
  );
}

// Step 20b (decision 6): a POS shift is open on this device. Signing out would delete its count
// and its sales not synced yet, and keep the register held, so it waits for the close. From the
// shell, "Close shift" goes to the POS screen with the close open; on the lock screen there is no
// way to the POS until the PIN is typed, so it only says why.
export function ShiftOpenDialog({
  number,
  onClose,
  onCloseShift,
}: {
  number: string;
  onClose: () => void;
  onCloseShift?: () => void;
}) {
  const { t } = useLocale();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        title={t('pos.close.signOutTitle')}
        footer={
          <>
            <DialogClose asChild>
              <Button variant={onCloseShift ? 'secondary' : 'primary'}>{t('common.cancel')}</Button>
            </DialogClose>
            {onCloseShift && (
              <Button
                onClick={() => {
                  onClose();
                  onCloseShift();
                }}
              >
                {t('pos.close.signOutClose')}
              </Button>
            )}
          </>
        }
      >
        <p className="text-body-sm text-ink-2">{t('pos.close.signOutBody', { number })}</p>
      </DialogContent>
    </Dialog>
  );
}
