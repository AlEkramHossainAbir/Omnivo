import { Alert02Icon, WifiDisconnected02Icon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { contractErrorMap } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { MAX_WRONG_PINS } from '@omnivo/sync';
import { Button } from '@omnivo/ui';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { type LockReason, useDeviceState } from '../lib/local-data';
import { unlockFormSchema } from '../lib/pin';
import { logout, signInAgain } from '../lib/session';
import { useSession } from '../lib/session-store';
import { useOnline } from '../lib/use-online';
import { AuthLayout } from './auth-layout';
import { DocumentNotice } from './document-notice';
import { PinField } from './pin-field';
import { SignOutDialog } from './sign-out-dialog';

const DESCRIPTIONS = {
  locked: 'pin.lock.description',
  offline: 'pin.lock.offlineDescription',
  'key-changed': 'pin.lock.keyChangedDescription',
} as const satisfies Record<LockReason, string>;

const linkClass = 'font-medium text-brand underline-offset-[3px] hover:underline';

// Step 19b (decision 7): the lock screen, in the AppShell's place while the copy waits for the PIN
// (app-frame.tsx). The session (the LocalDataHost) runs on beside it and puts the lock's state and
// actions in the store.
export function LockScreen() {
  const { t, format } = useLocale();
  const device = useDeviceState();
  const me = useSession((state) => state.me);
  const openedOffline = useSession((state) => state.openedOffline);
  const online = useOnline();
  const [asking, setAsking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const {
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(unlockFormSchema, { error: contractErrorMap }),
    defaultValues: { pin: '' },
  });

  // null while the session reads the key's row: the AppShell shows this screen from the start, so
  // the shell never shows for a moment before it
  const lock = device.kind === 'locked' ? device : null;
  const reason = lock?.reason ?? (openedOffline ? 'offline' : 'locked');
  const max = format.number(MAX_WRONG_PINS);

  const onSubmit = handleSubmit(async ({ pin }) => {
    if (!lock) return;
    const answer = await lock.unlock(pin);
    // open: the AppShell draws the app instead. pin-blocked: the screen shows the blocked state.
    if (answer.kind !== 'wrong-pin') return;
    // Empty again, for the next try; the error says how many are left
    setValue('pin', '');
    setError('pin', {
      message: t('pin.wrong', { count: answer.left, formatted: format.number(answer.left) }),
    });
  });

  // Decision 35: the PIN goes, the sign-in ends, and the password opens the copy; the dialog then
  // asks for a new PIN
  const toPassword = async () => {
    if (!lock) return;
    setLeaving(true);
    await lock.forgetPin();
    await signInAgain();
  };

  const signOut = () => {
    if (lock && lock.waiting > 0) setAsking(true);
    else void logout();
  };

  return (
    <AuthLayout>
      <h1 className="text-[28px] leading-[1.2]">{t('pin.lock.title')}</h1>
      <p className="mt-2 text-ink-2">{t(DESCRIPTIONS[reason])}</p>

      {me && (
        <p className="mt-6 grid rounded-control border border-line px-3 py-2.5">
          <span className="truncate text-body-sm font-medium">{me.user.fullName}</span>
          <span className="truncate text-caption text-ink-3">{me.user.email}</span>
        </p>
      )}

      {lock?.status.hasPin && (
        <>
          <form
            noValidate
            onSubmit={(event) => void onSubmit(event)}
            className="mt-6 grid gap-[18px]"
          >
            <Controller
              control={control}
              name="pin"
              render={({ field }) => (
                <PinField
                  label={t('pin.label')}
                  // The one field on the page, and the reason it is there
                  autoFocus
                  name={field.name}
                  ref={field.ref}
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  error={errors.pin?.message}
                />
              )}
            />
            <Button type="submit" disabled={isSubmitting} className="w-full">
              {isSubmitting ? t('pin.lock.unlocking') : t('pin.lock.unlock')}
            </Button>
          </form>
          {/* "Forgot PIN?" needs the password, so the server: offline it only says what to do */}
          <p className="mt-5 text-center text-body-sm text-ink-2">
            {online ? (
              <button
                type="button"
                disabled={leaving}
                className={linkClass}
                onClick={() => void toPassword()}
              >
                {t('pin.lock.forgot')}
              </button>
            ) : (
              t('pin.lock.forgotOffline')
            )}
          </p>
        </>
      )}

      {/* No PIN: too many wrong ones (or forgotten in another tab). Only the password opens it. */}
      {lock && !lock.status.hasPin && (
        <div className="mt-6 grid gap-[18px]">
          {online ? (
            <>
              {lock.status.pinBlocked && (
                <DocumentNotice tone="warn" icon={Alert02Icon}>
                  {t('pin.blocked', { max })}
                </DocumentNotice>
              )}
              <Button disabled={leaving} className="w-full" onClick={() => void toPassword()}>
                {t('pin.lock.signIn')}
              </Button>
            </>
          ) : (
            <DocumentNotice
              tone={lock.status.pinBlocked ? 'warn' : 'neutral'}
              icon={WifiDisconnected02Icon}
            >
              {lock.status.pinBlocked
                ? t('pin.lock.blockedOffline', { max })
                : t('pin.lock.forgotOffline')}
            </DocumentNotice>
          )}
        </div>
      )}

      {lock && (
        <p className="mt-7 text-center text-body-sm">
          <button type="button" className={linkClass} onClick={signOut}>
            {t('common.signOut')}
          </button>
        </p>
      )}

      {asking && lock && (
        <SignOutDialog
          count={lock.waiting}
          onClose={() => {
            setAsking(false);
          }}
        />
      )}
    </AuthLayout>
  );
}
