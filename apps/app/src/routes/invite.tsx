import { LinkBackwardIcon, LockPasswordIcon, UserIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  acceptInvitationInputSchema,
  contractErrorMap,
  type InvitationPreview,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, FormAlert, Logo, TextField, toast } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useForm } from 'react-hook-form';

import { LanguageSwitch } from '../components/language-switch';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { acceptInvitation } from '../lib/session';

// discriminated union-এর দুই রূপ আলাদা ফর্মে — একটা useForm-এ union রাখলে প্রতিটা ঘরের টাইপ
// "হয় এটা, নয় ওটা" হয়ে যেত। options-এর ক্রম চুক্তিতে: [0] = নতুন, [1] = পুরনো অ্যাকাউন্ট
const [newAccountSchema, existingAccountSchema] = acceptInvitationInputSchema.options;
const NEW_FIELDS = newAccountSchema.keyof().options;
const EXISTING_FIELDS = existingAccountSchema.keyof().options;

interface FormProps {
  token: string;
  preview: InvitationPreview;
}

function useJoined(preview: InvitationPreview) {
  const { t } = useLocale();
  const navigate = useNavigate();
  return async () => {
    toast(t('invite.joined', { workspace: preview.workspace.name }));
    await navigate({ to: '/' });
  };
}

function NewAccountForm({ token, preview }: FormProps) {
  const { t } = useLocale();
  const joined = useJoined(preview);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(newAccountSchema, { error: contractErrorMap }),
    defaultValues: { account: 'new' as const, token, fullName: '', password: '' },
  });
  const onSubmit = handleSubmit(async (values) => {
    try {
      await acceptInvitation(values);
      await joined();
    } catch (error) {
      applyApiError(error, NEW_FIELDS, setError);
    }
  });

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="mt-8 grid gap-[18px]">
      {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
      <TextField
        label={t('invite.fullName')}
        icon={UserIcon}
        autoComplete="name"
        placeholder="Tanvir Hossain"
        {...register('fullName')}
        error={errors.fullName?.message}
      />
      <TextField
        label={t('invite.password')}
        icon={LockPasswordIcon}
        type="password"
        autoComplete="new-password"
        placeholder={t('invite.newPasswordPlaceholder')}
        {...register('password')}
        error={errors.password?.message}
      />
      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting
          ? t('invite.submitting')
          : t('invite.submit', { workspace: preview.workspace.name })}
      </Button>
    </form>
  );
}

function ExistingAccountForm({ token, preview }: FormProps) {
  const { t } = useLocale();
  const joined = useJoined(preview);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(existingAccountSchema, { error: contractErrorMap }),
    defaultValues: { account: 'existing' as const, token, password: '' },
  });
  const onSubmit = handleSubmit(async (values) => {
    try {
      await acceptInvitation(values);
      await joined();
    } catch (error) {
      applyApiError(error, EXISTING_FIELDS, setError);
    }
  });

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="mt-8 grid gap-[18px]">
      {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
      <TextField
        label={t('invite.password')}
        icon={LockPasswordIcon}
        type="password"
        autoComplete="current-password"
        placeholder={t('invite.existingPasswordPlaceholder')}
        {...register('password')}
        error={errors.password?.message}
      />
      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting
          ? t('invite.submitting')
          : t('invite.submit', { workspace: preview.workspace.name })}
      </Button>
    </form>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg px-4 py-8 sm:px-16">
      <Logo />
      <div className="grid flex-1 place-items-center py-10">
        <div className="w-full max-w-[420px]">{children}</div>
      </div>
      <div className="flex justify-end">
        <LanguageSwitch />
      </div>
    </div>
  );
}

// ইমেইলের লিংক: /invite#<token>। token # (fragment)-এর পরে — ব্রাউজার সেটা কখনো সার্ভারে পাঠায় না
// (contracts/invitations.ts)। লগইন ছাড়াই খোলে; আগে অন্য অ্যাকাউন্টে লগইন থাকলেও চলে — গ্রহণ করলে
// নতুন session সেটার জায়গা নেয়
export function InvitePage() {
  const { t, format } = useLocale();
  const token = useLocation({ select: (location) => location.hash });
  const { data: preview, isError } = useQuery({
    queryKey: ['invitation-preview', token],
    queryFn: () => call(routes.invitations.lookup, { body: { token } }),
    // ভুল/পুরনো লিংকে ৩ বার আবার চেষ্টা করার কিছু নেই — উত্তর বদলাবে না
    retry: false,
    enabled: token.length > 0,
  });

  if (token.length === 0 || isError) {
    return (
      <Frame>
        <Card className="p-8 text-center">
          <span className="mx-auto grid size-10 place-items-center rounded-lg bg-brand-soft text-brand">
            <HugeiconsIcon icon={LinkBackwardIcon} size={18} strokeWidth={1.5} />
          </span>
          <h1 className="mt-3 text-h3">{t('invite.invalidTitle')}</h1>
          <p className="mt-1 text-body-sm text-ink-2">{t('invite.invalidBody')}</p>
          <Link
            to="/login"
            className="mt-4 inline-block font-medium text-brand underline-offset-[3px] hover:underline"
          >
            {t('invite.toSignIn')}
          </Link>
        </Card>
      </Frame>
    );
  }

  if (!preview) {
    return (
      <Frame>
        <p className="text-center text-body-sm text-ink-3">{t('invite.checking')}</p>
      </Frame>
    );
  }

  return (
    <Frame>
      <h1 className="text-[28px] leading-[1.2]">
        {t('invite.title', { workspace: preview.workspace.name })}
      </h1>
      <p className="mt-2 text-ink-2">
        {preview.invitedBy
          ? t('invite.invitedBy', { name: preview.invitedBy, email: preview.email })
          : t('invite.invitedAs', { email: preview.email })}{' '}
        {preview.accountExists ? t('invite.existingAccount') : t('invite.newAccount')}
      </p>
      {preview.accountExists ? (
        <ExistingAccountForm token={token} preview={preview} />
      ) : (
        <NewAccountForm token={token} preview={preview} />
      )}
      <p className="mt-6 text-center text-label text-ink-3">
        {t('invite.expires', { date: format.date(new Date(preview.expiresAt)) })}
      </p>
    </Frame>
  );
}
