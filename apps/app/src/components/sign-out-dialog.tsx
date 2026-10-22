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
