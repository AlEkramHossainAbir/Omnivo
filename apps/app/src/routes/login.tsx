import {
  Building03Icon,
  LockPasswordIcon,
  Mail01Icon,
  ViewIcon,
  ViewOffIcon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { contractErrorMap, loginInputSchema } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Checkbox, FormAlert, TextField } from '@omnivo/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { AuthLayout } from '../components/auth-layout';
import { DocumentNotice } from '../components/document-notice';
import { applyApiError } from '../lib/field-errors';
import { login } from '../lib/session';
import { useSession } from '../lib/session-store';
import { useOnline } from '../lib/use-online';

export function LoginPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  // Step 18c: why this page shows, when the app signed the person out (a revoked device)
  const notice = useSession((state) => state.notice);
  // Step 19a: signing in needs the server; saying so first saves typing a password for nothing
  const online = useOnline();
  // zodResolver: API যে schema দিয়ে যাচাই করে, ফর্মও ঠিক সেটা দিয়ে — একই নিয়ম, একই code।
  // contractErrorMap: schema যেখানে নিজে code দেয়নি সেখানে Zod-এর ইংরেজি মেসেজের বদলে code
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(loginInputSchema, { error: contractErrorMap }),
    defaultValues: { workspace: '', email: '', password: '', keepSignedIn: true },
  });

  // handleSubmit: আগে Zod যাচাই, পাস করলে তবেই এই ফাংশন — values-এর টাইপ LoginInput
  // (trim/lowercase হয়ে গেছে)। চলার সময় isSubmitting নিজে থেকেই true
  const onSubmit = handleSubmit(async (values) => {
    try {
      await login(values);
      await navigate({ to: '/' });
    } catch (error) {
      applyApiError(error, loginInputSchema.keyof().options, setError);
    }
  });

  return (
    <AuthLayout>
      <h1 className="text-[28px] leading-[1.2]">{t('auth.login.title')}</h1>
      <p className="mt-2 text-ink-2">{t('auth.login.subtitle')}</p>

      <form noValidate onSubmit={(event) => void onSubmit(event)} className="mt-8 grid gap-[18px]">
        {/* Step 18c: not an error of the form, so the neutral notice, not FormAlert. It stays
            until the next sign-in, which clears it (session-store.ts). */}
        {notice === 'device_revoked' && (
          <DocumentNotice tone="neutral">{t('devices.revokedSignedOut')}</DocumentNotice>
        )}
        {/* Step 19a (decision 19): signed out after an offline opening; the copy stays */}
        {notice === 'session_ended' && (
          <DocumentNotice tone="neutral">{t('auth.login.sessionEnded')}</DocumentNotice>
        )}
        {/* Step 19b (decision 31): "Forgot PIN?", or a PIN that stopped working; the copy stays */}
        {notice === 'pin_reset' && (
          <DocumentNotice tone="neutral">{t('auth.login.pinNotice')}</DocumentNotice>
        )}
        {/* Step 19b (decision 5): a device without a PIN says why its copy did not open offline,
            in the offline notice's place (it says to connect too) */}
        {!online && (
          <DocumentNotice tone="neutral" icon={WifiDisconnected02Icon}>
            {notice === 'no_pin' ? t('auth.login.noPinNotice') : t('auth.login.offlineNotice')}
          </DocumentNotice>
        )}
        {/* message-এ code; FormAlert আর TextField নিজেরাই বর্তমান ভাষায় লেখে */}
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <TextField
          label={t('auth.workspace')}
          icon={Building03Icon}
          suffix=".omnivo.app"
          autoComplete="organization"
          autoCapitalize="none"
          spellCheck={false}
          // উদাহরণ ঠিকানা — ঠিকানা সবসময় ইংরেজি অক্ষরে, তাই অনুবাদ নেই
          placeholder="rahman-garments"
          {...register('workspace')}
          error={errors.workspace?.message}
        />
        <TextField
          label={t('auth.email')}
          icon={Mail01Icon}
          type="email"
          autoComplete="email"
          placeholder="name@company.com"
          {...register('email')}
          error={errors.email?.message}
        />
        <TextField
          label={t('auth.password')}
          icon={LockPasswordIcon}
          type={showPassword ? 'text' : 'password'}
          autoComplete="current-password"
          placeholder={t('auth.login.passwordPlaceholder')}
          {...register('password')}
          error={errors.password?.message}
          trailing={
            <button
              type="button"
              aria-label={
                showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')
              }
              onClick={() => {
                setShowPassword(!showPassword);
              }}
              className="-mr-1.5 grid place-items-center rounded-md p-1.5 text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink"
            >
              <HugeiconsIcon
                icon={showPassword ? ViewOffIcon : ViewIcon}
                size={17}
                strokeWidth={1.5}
              />
            </button>
          }
        />
        {/* Radix Checkbox আসল <input> না, তাই register চলে না — Controller মান আর onChange জোড়ে */}
        <Controller
          control={control}
          name="keepSignedIn"
          render={({ field }) => (
            <Checkbox
              id="keepSignedIn"
              label={t('auth.login.keepSignedIn')}
              checked={field.value}
              // Radix-এর মান true | false | 'indeterminate' — আমাদের schema শুধু boolean
              onCheckedChange={(checked) => {
                field.onChange(checked === true);
              }}
            />
          )}
        />
        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting ? t('auth.login.submitting') : t('auth.login.submit')}
        </Button>
      </form>

      <p className="mt-7 text-center text-body-sm text-ink-2">
        {t('auth.login.newHere')}{' '}
        <Link
          to="/sign-up"
          className="font-medium text-brand underline-offset-[3px] hover:underline"
        >
          {t('auth.login.createWorkspace')}
        </Link>
      </p>
    </AuthLayout>
  );
}
