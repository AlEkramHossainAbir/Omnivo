import { useLocale } from '@omnivo/i18n';
import { Button, Dialog, DialogClose, DialogContent } from '@omnivo/ui';

import type { InstallWay } from '../lib/install';

// Step 19a (decision 20): Safari can install the app, but only from its own menus, so the dialog
// says where. Only the steps of this device: an iPhone user has no File menu to look for.
export function InstallDialog({
  way,
  onClose,
}: {
  way: Exclude<InstallWay, 'prompt'>;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const steps =
    way === 'ios'
      ? [t('shell.install.iosStep1'), t('shell.install.iosStep2'), t('shell.install.iosStep3')]
      : [t('shell.install.macStep1'), t('shell.install.macStep2')];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        title={t('shell.install.title')}
        description={t('shell.install.description')}
        footer={
          <DialogClose asChild>
            <Button>{t('common.close')}</Button>
          </DialogClose>
        }
      >
        <section className="grid gap-2">
          <h3 className="text-body-sm font-medium">
            {way === 'ios' ? t('shell.install.iosTitle') : t('shell.install.macTitle')}
          </h3>
          <ol className="grid list-decimal gap-1.5 pl-5 text-body-sm text-ink-2">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
      </DialogContent>
    </Dialog>
  );
}
