import {
  Building03Icon,
  Globe02Icon,
  LockPasswordIcon,
  Mail01Icon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { contractErrorMap, type ErrorCode, signUpInputSchema } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, EmptyState, FormAlert, Logo, TextField, toast } from '@omnivo/ui';
import { Link } from '@tanstack/react-router';
import { type ChangeEvent, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { LanguageSwitch } from '../components/language-switch';
import { ApiRequestError } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { resendVerification, signUp } from '../lib/session';

// The API allows one new link a minute (auth/verification-limits.ts). The button waits as long,
// so a click never asks for a link the server will quietly not send
const RESEND_WAIT_SECONDS = 60;

// "Rahman Garments Ltd." → "rahman-garments" (Workspace Setup mockup-এর নিয়ম)
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(ltd|limited|pvt|plc)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

// After the sign-up: the workspace is made, and it opens from the email's link
// (routes/verify-email.tsx). Only the address is known here, the one the server stored. There is
// no "use another email": the workspace and its address are taken by now, so a second sign-up
// would only get slug_taken
function CheckEmail({ email }: { email: string }) {
  const { t } = useLocale();
  // The sign-up's own email just went, so the first resend waits too
  const [wait, setWait] = useState(RESEND_WAIT_SECONDS);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);

  // One tick a second while there is a wait. A new timer per tick (not setInterval), so the
  // countdown stops by itself at 0 and the cleanup never leaves one running after the page goes
  useEffect(() => {
    if (wait === 0) return;
    const timer = setTimeout(() => {
      setWait((seconds) => seconds - 1);
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [wait]);

  const resend = async () => {
    setSending(true);
    setError(null);
    try {
      await resendVerification(email);
      toast(t('auth.signUp.resent'));
      setWait(RESEND_WAIT_SECONDS);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.code : 'unknown_error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="grid gap-4">
      {error && <FormAlert message={error} />}
      <EmptyState
        icon={Mail01Icon}
        title={t('auth.signUp.checkTitle')}
        description={t('auth.signUp.checkBody', { email })}
        action={
          <div className="grid justify-items-center gap-3">
            <Button
              variant="secondary"
              disabled={wait > 0 || sending}
              onClick={() => void resend()}
            >
              {wait > 0 ? t('auth.signUp.resendIn', { seconds: wait }) : t('auth.signUp.resend')}
            </Button>
            <p className="text-label text-ink-3">{t('auth.signUp.checkHint')}</p>
          </div>
        }
      />
    </div>
  );
}

export function SignUpPage() {
  const { t } = useLocale();
  // The address the link went to; null = the form. One way: the workspace exists from here on
  const [sentTo, setSentTo] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    getFieldState,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(signUpInputSchema, { error: contractErrorMap }),
    defaultValues: { companyName: '', workspaceSlug: '', fullName: '', email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const { email } = await signUp(values);
      setSentTo(email);
    } catch (error) {
      applyApiError(error, signUpInputSchema.keyof().options, setError);
    }
  });

  return (
    <div className="min-h-dvh">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-surface px-4 py-5 sm:px-10">
        <Logo />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <p className="text-body-sm text-ink-2">
            {t('auth.signUp.haveWorkspace')}{' '}
            <Link
              to="/login"
              className="font-medium text-brand underline-offset-[3px] hover:underline"
            >
              {t('auth.signUp.signIn')}
            </Link>
          </p>
          <LanguageSwitch />
        </div>
      </header>

      <main className="mx-auto max-w-[640px] px-4 pt-10 pb-16">
        <div className="rounded-card border border-line bg-surface px-[18px] py-[22px] shadow-md sm:p-8">
          {sentTo !== null ? (
            <CheckEmail email={sentTo} />
          ) : (
            <>
              <h1 className="text-h2">{t('auth.signUp.title')}</h1>
              <p className="mt-1.5 text-ink-2">{t('auth.signUp.subtitle')}</p>

              <form
                noValidate
                onSubmit={(event) => void onSubmit(event)}
                className="mt-7 grid gap-5"
              >
                {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
                <TextField
                  label={t('auth.signUp.companyName')}
                  icon={Building03Icon}
                  autoComplete="organization"
                  // উদাহরণ ডেটা (নাম, ঠিকানা, ইমেইল) — দুই ভাষাতেই একই, তাই অনুবাদের ফাইলে না
                  placeholder="Rahman Garments Ltd."
                  {...register('companyName', {
                    // ইউজার নিজে ঠিকানায় হাত দিলে (isDirty) আর অটো-বসানো হবে না — আলাদা
                    // "slugTouched" state লাগে না। setValue ডিফল্টে dirty বানায় না, তাই অটো-বসানো
                    // মান পরের অক্ষরে আবার বদলাতে পারে
                    onChange: (event: ChangeEvent<HTMLInputElement>) => {
                      if (!getFieldState('workspaceSlug').isDirty) {
                        setValue('workspaceSlug', slugify(event.target.value));
                      }
                    },
                  })}
                  error={errors.companyName?.message}
                />
                <TextField
                  label={t('auth.signUp.workspaceAddress')}
                  icon={Globe02Icon}
                  suffix=".omnivo.app"
                  // ফোনের কীবোর্ড প্রথম অক্ষর বড় হাতের না করে; বাকিটা schema-র toLowerCase() সামলায়
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="rahman-garments"
                  {...register('workspaceSlug')}
                  error={errors.workspaceSlug?.message}
                />
                <div className="grid gap-5 sm:grid-cols-2 sm:gap-4">
                  <TextField
                    label={t('auth.signUp.fullName')}
                    icon={UserIcon}
                    autoComplete="name"
                    placeholder="Farhana Rahman"
                    {...register('fullName')}
                    error={errors.fullName?.message}
                  />
                  <TextField
                    label={t('auth.signUp.workEmail')}
                    icon={Mail01Icon}
                    type="email"
                    autoComplete="email"
                    placeholder="name@company.com"
                    {...register('email')}
                    error={errors.email?.message}
                  />
                </div>
                <TextField
                  label={t('auth.password')}
                  icon={LockPasswordIcon}
                  type="password"
                  autoComplete="new-password"
                  placeholder={t('auth.signUp.passwordPlaceholder')}
                  {...register('password')}
                  error={errors.password?.message}
                />

                <div className="mt-2 flex justify-end border-t border-line pt-6">
                  <Button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full sm:w-auto sm:min-w-40"
                  >
                    {isSubmitting ? t('auth.signUp.submitting') : t('auth.signUp.submit')}
                  </Button>
                </div>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
