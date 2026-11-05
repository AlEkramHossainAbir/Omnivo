import { Copy01Icon, LinkSquare02Icon, Mail01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type DocumentEmailDraft,
  type DocumentEmailFormValues,
  type DocumentEmailInput,
  documentEmailInputSchema,
  type LanguageCode,
  MAX_EMAIL_RECIPIENTS,
  type PartyRole,
  routes,
  SHARE_LINK_DAYS,
  whatsAppNumber,
} from '@omnivo/contracts';
import { LANGUAGES, useLocale } from '@omnivo/i18n';
import {
  Button,
  DialogClose,
  DialogContent,
  Field,
  FormAlert,
  Input,
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import type { OutputTarget } from '../lib/document-output';
import { documentEmailsQuery, documentSharesQuery, emailDraftQuery } from '../lib/document-queries';
import { settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { failureOf } from './journal-parts';

// The Send menu's two dialogs (step 16), a lazy chunk of their own: send-menu.tsx says why.

const LANGUAGE_OPTIONS = LANGUAGES.map((language) => ({
  value: language.code,
  label: language.label,
}));

const EMAIL_FIELDS = ['to', 'cc', 'subject', 'message', 'language'] as const;

function useTenant(): string {
  return useSession((state) => state.me?.tenant.id) ?? '';
}

// "Email": the server's draft in the customer's language first, then the form. The dialog shows
// once the draft is there (a fraction of a second): a form that fills itself while someone types
// into it would lose what they typed.
export function EmailForm({
  target,
  role,
  language,
  onDone,
}: {
  target: OutputTarget;
  // Step 17b: who it goes to, for the words when they have no email (the Send menu knows)
  role: PartyRole;
  language: LanguageCode;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const draft = useQuery(emailDraftQuery(useTenant(), target.kind, target.id, language));
  if (draft.isError) {
    return (
      <DialogContent title={t('documentOutput.emailDialog.title', { number: target.number })}>
        <p className="text-body-sm text-crit">{t('documentOutput.emailDialog.loadFailed')}</p>
      </DialogContent>
    );
  }
  if (!draft.data) return null;
  return (
    <EmailFields
      target={target}
      role={role}
      language={language}
      draft={draft.data}
      onDone={onDone}
    />
  );
}

function EmailFields({
  target,
  role,
  language,
  draft,
  onDone,
}: {
  target: OutputTarget;
  role: PartyRole;
  language: LanguageCode;
  draft: DocumentEmailDraft;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const tenantId = useTenant();
  const queryClient = useQueryClient();
  const replyTo = useQuery(settingsQuery(tenantId)).data?.email ?? null;
  const { kind, id } = target;
  const [rewriting, setRewriting] = useState(false);
  const {
    register,
    handleSubmit,
    getValues,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<DocumentEmailFormValues, unknown, DocumentEmailInput>({
    resolver: zodResolver(documentEmailInputSchema, { error: contractErrorMap }),
    defaultValues: {
      to: draft.to,
      cc: '',
      subject: draft.subject,
      message: draft.message,
      language,
    },
  });

  // A new language writes the subject and the message again, from the server's draft in that
  // language (decision 30); To and CC stay as typed. A second change before the first answer
  // came back wins: the older answer is dropped when it arrives.
  const rewrite = async () => {
    const wanted = getValues('language');
    setRewriting(true);
    try {
      const next = await queryClient.query(emailDraftQuery(tenantId, kind, id, wanted));
      if (getValues('language') !== wanted) return;
      setValue('subject', next.subject, { shouldValidate: true });
      setValue('message', next.message);
    } catch (error) {
      applyApiError(error, EMAIL_FIELDS, setError);
    } finally {
      setRewriting(false);
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    // The body is what the schema takes in (one string per box), so the cleaned lists go back as
    // text: lower case, no duplicates, the way the server will read them again
    const body = { ...values, to: values.to.join(', '), cc: values.cc.join(', ') };
    try {
      await call(routes.documentOutput.sendEmail, { params: { kind, id }, body });
      await queryClient.invalidateQueries({
        queryKey: documentEmailsQuery(tenantId, kind, id).queryKey,
      });
      // "Sending", not "Sent": the request only queues it, and the history shows when it went
      toast(t('documentOutput.emailDialog.sent', { to: body.to }));
      onDone();
    } catch (error) {
      applyApiError(error, EMAIL_FIELDS, setError);
    }
  });

  const hint = t('documentOutput.emailDialog.recipientsHint', { max: MAX_EMAIL_RECIPIENTS });
  return (
    <DialogContent
      title={t('documentOutput.emailDialog.title', { number: target.number })}
      description={
        replyTo === null
          ? t('documentOutput.emailDialog.noReplyTo')
          : t('documentOutput.emailDialog.replyTo', { email: replyTo })
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="email-form" disabled={isSubmitting || rewriting}>
            <HugeiconsIcon icon={Mail01Icon} size={17} strokeWidth={1.5} />
            {isSubmitting
              ? t('documentOutput.emailDialog.sending')
              : t('documentOutput.emailDialog.send')}
          </Button>
        </>
      }
    >
      <form
        id="email-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <SelectField
          label={t('documentOutput.emailDialog.language')}
          hint={t('documentOutput.emailDialog.languageHint')}
          options={LANGUAGE_OPTIONS}
          {...register('language', {
            onChange: () => {
              void rewrite();
            },
          })}
          error={errors.language?.message}
        />
        <TextField
          label={t('documentOutput.emailDialog.to')}
          // An address list, not one address: type="email" would refuse the comma
          type="text"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('documentOutput.emailDialog.toPlaceholder')}
          // The customer (17b: the supplier) has no email: say so under the box until someone
          // types one
          hint={
            draft.to === ''
              ? t(
                  role === 'supplier'
                    ? 'documentOutput.emailDialog.noSupplierEmail'
                    : 'documentOutput.emailDialog.noCustomerEmail',
                )
              : hint
          }
          {...register('to')}
          error={errors.to?.message}
        />
        <TextField
          label={t('documentOutput.emailDialog.cc')}
          optional
          type="text"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          hint={hint}
          {...register('cc')}
          error={errors.cc?.message}
        />
        <TextField
          label={t('documentOutput.emailDialog.subject')}
          {...register('subject')}
          error={errors.subject?.message}
        />
        <TextAreaField
          label={t('documentOutput.emailDialog.message')}
          rows={6}
          hint={t('documentOutput.emailDialog.messageHint')}
          {...register('message')}
          error={errors.message?.message}
        />
        {/* The name the API gives the attachment (email.handler.ts) */}
        <p className="text-label text-ink-3">
          {t('documentOutput.emailDialog.attachment', { file: `${target.number}.pdf` })}
        </p>
      </form>
    </DialogContent>
  );
}

// The browser's clipboard can refuse (an old browser, a page not on HTTPS): then the person
// selects the text in its box and copies it themselves
function useCopy(): (text: string, done: string) => void {
  const { t } = useLocale();
  return (text, done) => {
    navigator.clipboard.writeText(text).then(
      () => {
        toast(done);
      },
      () => {
        toast(t('documentOutput.copyFailed'));
      },
    );
  };
}

// The primary button's look on a real link. "Open WhatsApp" must be an <a> the person clicks:
// a window opened by the page after the request came back is blocked by Safari and Firefox
// (decision 28).
const LINK_BUTTON =
  'inline-flex min-h-[42px] items-center justify-center gap-2 rounded-control bg-brand px-4 text-body font-medium whitespace-nowrap text-brand-ink shadow-sm transition-colors duration-150 hover:bg-brand-hover';

// "Share on WhatsApp": pick the language, make the link, then copy it or open WhatsApp with the
// message ready. The link is shown only here (decision 13): closing the dialog forgets it.
export function ShareForm({
  target,
  role,
  language,
  phone,
}: {
  target: OutputTarget;
  role: PartyRole;
  language: LanguageCode;
  phone: string | null;
}) {
  const { t } = useLocale();
  const tenantId = useTenant();
  const queryClient = useQueryClient();
  const copy = useCopy();
  const linkId = useId();
  const [chosen, setChosen] = useState<LanguageCode>(language);
  const { kind, id } = target;
  const create = useMutation({
    mutationFn: () =>
      call(routes.documentOutput.createShare, { params: { kind, id }, body: { language: chosen } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: documentSharesQuery(tenantId, kind, id).queryKey,
      });
    },
  });
  const failure = failureOf(create.error);
  const title = t('documentOutput.shareDialog.title', { number: target.number });
  const description = t('documentOutput.shareDialog.description', { days: SHARE_LINK_DAYS });
  const created = create.data;

  if (!created) {
    return (
      <DialogContent
        title={title}
        description={description}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">{t('common.cancel')}</Button>
            </DialogClose>
            <Button
              disabled={create.isPending}
              onClick={() => {
                create.mutate();
              }}
            >
              {create.isPending
                ? t('documentOutput.shareDialog.creating')
                : t('documentOutput.shareDialog.create')}
            </Button>
          </>
        }
      >
        <div className="grid gap-5">
          {failure && <FormAlert message={failure} />}
          <SelectField
            label={t('documentOutput.shareDialog.language')}
            hint={t('documentOutput.shareDialog.languageHint')}
            options={LANGUAGE_OPTIONS}
            value={chosen}
            onChange={(event) => {
              const next = LANGUAGES.find((item) => item.code === event.target.value);
              if (next) setChosen(next.code);
            }}
          />
        </div>
      </DialogContent>
    );
  }

  return (
    <DialogContent
      title={title}
      description={description}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.close')}</Button>
          </DialogClose>
          <a
            href={created.whatsAppUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK_BUTTON}
          >
            {/* It opens another app or tab. Not the WhatsApp icon: the Send menu has that one, and
                a module used only by the menu and this dialog would make the bundler fold it into
                the menu's chunk (send-menu.tsx says what that costs). */}
            <HugeiconsIcon icon={LinkSquare02Icon} size={17} strokeWidth={1.5} />
            {t('documentOutput.shareDialog.openWhatsApp')}
          </a>
        </>
      }
    >
      <div className="grid gap-5">
        <Field
          id={linkId}
          label={t('documentOutput.shareDialog.link')}
          hint={t('documentOutput.shareDialog.shownOnce')}
        >
          {/* Read only, and selected on focus: one tap selects it for copying by hand */}
          <Input
            id={linkId}
            readOnly
            value={created.url}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
          />
        </Field>
        <TextAreaField
          label={t('documentOutput.shareDialog.message')}
          readOnly
          rows={4}
          value={created.message}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              copy(created.url, t('documentOutput.shareDialog.linkCopied'));
            }}
          >
            <HugeiconsIcon icon={Copy01Icon} size={16} strokeWidth={1.5} />
            {t('documentOutput.shareDialog.copyLink')}
          </Button>
          {/* For a customer on Messenger or IMO, or for an SMS */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              copy(created.message, t('documentOutput.shareDialog.messageCopied'));
            }}
          >
            <HugeiconsIcon icon={Copy01Icon} size={16} strokeWidth={1.5} />
            {t('documentOutput.shareDialog.copyMessage')}
          </Button>
        </div>
        {/* The same reading of the phone the server used for the link (decision 17) */}
        {whatsAppNumber(phone) === null && (
          <p className="text-label text-ink-3">
            {t(
              role === 'supplier'
                ? 'documentOutput.shareDialog.noSupplierNumber'
                : 'documentOutput.shareDialog.noNumber',
            )}
          </p>
        )}
      </div>
    </DialogContent>
  );
}
