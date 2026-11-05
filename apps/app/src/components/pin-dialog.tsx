import { zodResolver } from '@hookform/resolvers/zod';
import { contractErrorMap } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import type { KeyProblem } from '@omnivo/sync';
import { Button, Dialog, DialogContent, FormAlert, toast } from '@omnivo/ui';
import { useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { applyApiError } from '../lib/field-errors';
import { askForPin, type PinDialogKind, type PinSave } from '../lib/local-data';
import { pinFormSchema } from '../lib/pin';
import { PinField } from './pin-field';

const FIELD_NAMES = ['current', 'pin', 'repeat'] as const;

const TITLES = {
  'set-up': 'pin.setUpTitle',
  new: 'pin.newTitle',
  change: 'pin.changeTitle',
} as const satisfies Record<PinDialogKind, string>;

// Step 19b (decision 5): set or change the device PIN. After set-up the session opens it ("Not
// now" and any other way of closing it mean not now); the Sync page's card and the account menu
// open it later. The session's two actions come as props from the host, like the branch dialog's:
// an import of local-session here would count Dexie into this lazy chunk a second time.
export function PinDialog({
  kind,
  savePin,
  close,
}: {
  kind: PinDialogKind;
  savePin: (save: PinSave) => Promise<{ kind: 'set' } | KeyProblem>;
  close: () => void;
}) {
  const { t, format } = useLocale();
  const change = kind === 'change';
  // The host remounts the dialog when the kind changes (key), so the schema is made once
  const schema = useMemo(() => pinFormSchema(change), [change]);
  const {
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(schema, { error: contractErrorMap }),
    defaultValues: { current: '', pin: '', repeat: '' },
  });

  const onSubmit = handleSubmit(async ({ current, pin }) => {
    try {
      const answer = await savePin({ current: change ? current : '', pin });
      switch (answer.kind) {
        case 'set':
          toast(t(change ? 'pin.changed' : 'pin.set'));
          close();
          return;
        case 'wrong-pin':
          setValue('current', '');
          setError('current', {
            message: t('pin.wrong', { count: answer.left, formatted: format.number(answer.left) }),
          });
          return;
        // The fifth wrong current PIN turned the PIN off: the dialog for a new one takes this
        // one's place, which sets it with the server's key
        case 'pin-blocked':
          askForPin('new');
          return;
        // no-pin and key-changed: the copy opened, so neither can happen here
        default:
          setError('root.server', { message: 'unknown_error' });
      }
    } catch (error) {
      // No connection, for a new PIN (it needs the server's key)
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        title={t(TITLES[kind])}
        description={
          kind === 'set-up'
            ? t('pin.setUpDescription')
            : kind === 'new'
              ? t('pin.newDescription')
              : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              {change ? t('common.cancel') : t('pin.later')}
            </Button>
            <Button type="submit" form="pin-form" disabled={isSubmitting}>
              {isSubmitting ? t('pin.saving') : change ? t('pin.saveChange') : t('pin.save')}
            </Button>
          </>
        }
      >
        <form
          id="pin-form"
          noValidate
          onSubmit={(event) => void onSubmit(event)}
          className="grid gap-5"
        >
          {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
          {change && (
            <Controller
              control={control}
              name="current"
              render={({ field }) => (
                <PinField
                  label={t('pin.current')}
                  name={field.name}
                  ref={field.ref}
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  error={errors.current?.message}
                />
              )}
            />
          )}
          <Controller
            control={control}
            name="pin"
            render={({ field }) => (
              <PinField
                label={change ? t('pin.newPin') : t('pin.label')}
                hint={t('pin.hint')}
                name={field.name}
                ref={field.ref}
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                error={errors.pin?.message}
              />
            )}
          />
          <Controller
            control={control}
            name="repeat"
            render={({ field }) => (
              <PinField
                label={t('pin.repeat')}
                name={field.name}
                ref={field.ref}
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                error={errors.repeat?.message}
              />
            )}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
