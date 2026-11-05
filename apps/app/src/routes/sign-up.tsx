import {
  Building03Icon,
  Globe02Icon,
  LockPasswordIcon,
  Mail01Icon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { contractErrorMap, signUpInputSchema } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, FormAlert, Logo, TextField } from '@omnivo/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ChangeEvent } from 'react';
import { useForm } from 'react-hook-form';

import { LanguageSwitch } from '../components/language-switch';
import { applyApiError } from '../lib/field-errors';
import { signUp } from '../lib/session';

// "Rahman Garments Ltd." → "rahman-garments" (Workspace Setup mockup-এর নিয়ম)
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(ltd|limited|pvt|plc)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function SignUpPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
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
      await signUp(values);
      await navigate({ to: '/' });
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
          <h1 className="text-h2">{t('auth.signUp.title')}</h1>
          <p className="mt-1.5 text-ink-2">{t('auth.signUp.subtitle')}</p>

          <form noValidate onSubmit={(event) => void onSubmit(event)} className="mt-7 grid gap-5">
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
        </div>
      </main>
    </div>
  );
}
