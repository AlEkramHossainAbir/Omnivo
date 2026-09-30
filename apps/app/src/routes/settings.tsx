import {
  Building03Icon,
  Calendar03Icon,
  Call02Icon,
  Globe02Icon,
  IdentityCardIcon,
  Image01Icon,
  Mail01Icon,
  Money03Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ATTACHMENT_RULES,
  contractErrorMap,
  createUploadInputSchema,
  CURRENCIES,
  type ErrorCode,
  isErrorCode,
  routes,
  type Settings,
  updateSettingsInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  FormAlert,
  PageHeader,
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, useMemo, useRef } from 'react';
import { useForm } from 'react-hook-form';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { settingsQuery } from '../lib/queries';
import { settingsToForm } from '../lib/settings-form';
import { refreshMe } from '../lib/session';
import { useCan } from '../lib/permissions';
import { useSession } from '../lib/session-store';

const FIELD_NAMES = updateSettingsInputSchema.keyof().options;
const CURRENCY_OPTIONS = CURRENCIES.map((currency) => ({ value: currency, label: currency }));
const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);

// ব্রাউজারের জানা সব IANA টাইমজোন (~৪০০) — আলাদা তালিকা রাখতে হয় না। বর্তমান মান তালিকায় না থাকলে
// (যেমন "UTC" কিছু ব্রাউজারে নেই) সেটাও রাখা, নাহলে select চুপচাপ প্রথম মানে সরে যেত
function timeZoneOptions(current: string) {
  const zones = Intl.supportedValuesOf('timeZone');
  return (zones.includes(current) ? zones : [current, ...zones]).map((zone) => ({
    value: zone,
    label: zone.replaceAll('_', ' '),
  }));
}

function SettingsForm({ settings, canManage }: { settings: Settings; canManage: boolean }) {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(updateSettingsInputSchema, { error: contractErrorMap }),
    defaultValues: settingsToForm(settings),
  });

  const monthOptions = useMemo(
    () => MONTHS.map((month) => ({ value: String(month), label: format.monthName(month) })),
    [format],
  );
  const zoneOptions = useMemo(() => timeZoneOptions(settings.timezone), [settings.timezone]);

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.settings.update, { body: values });
      queryClient.setQueryData(settingsQuery(tenantId).queryKey, saved);
      // নতুন version সহ ফর্ম নতুন করে — পরের সেভ এই version থেকে
      reset(settingsToForm(saved));
      toast(t('settings.saved'));
      // কোম্পানির নাম বদলালে switcher-এও নতুন নাম
      await refreshMe();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  // conflict-এর পরে: সার্ভারের সর্বশেষ মান এনে ফর্ম সেখান থেকে। staleTime 0 — ক্যাশের পুরনো মান না।
  // query(): TanStack v5.104-এ fetchQuery-র নতুন নাম (পুরনোটা deprecated)
  const reload = async () => {
    const fresh = await queryClient.query({ ...settingsQuery(tenantId), staleTime: 0 });
    reset(settingsToForm(fresh));
  };

  const serverError = errors.root?.server?.message;

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="grid gap-5">
      {serverError && (
        <div className="grid gap-2">
          <FormAlert message={serverError} />
          {serverError === 'version_conflict' && (
            <div>
              <Button variant="secondary" size="sm" onClick={() => void reload()}>
                {t('common.reload')}
              </Button>
            </div>
          )}
        </div>
      )}
      {/* disabled fieldset: ভেতরের সব ঘর একসাথে শুধু-পড়া — প্রতিটা ইনপুটে আলাদা prop লাগে না */}
      <fieldset disabled={!canManage} className="grid min-w-0 gap-5">
        <Card>
          <CardHeader title={t('settings.companyTitle')} subtitle={t('settings.companySubtitle')} />
          <div className="grid gap-5 p-5 sm:grid-cols-2 sm:gap-x-4">
            <TextField
              label={t('settings.companyName')}
              icon={Building03Icon}
              autoComplete="organization"
              {...register('companyName')}
              error={errors.companyName?.message}
            />
            <TextField
              label={t('settings.legalName')}
              optional
              hint={t('settings.legalNameHint')}
              placeholder="Rahman Knit Garments Limited"
              {...register('legalName')}
              error={errors.legalName?.message}
            />
            <TextField
              label={t('settings.bin')}
              icon={IdentityCardIcon}
              optional
              inputMode="numeric"
              hint={t('settings.binHint')}
              placeholder="000123456-0101"
              {...register('bin')}
              error={errors.bin?.message}
            />
            <TextField
              label={t('settings.phone')}
              icon={Call02Icon}
              optional
              type="tel"
              placeholder="+880 1711-000000"
              {...register('phone')}
              error={errors.phone?.message}
            />
            <TextField
              label={t('settings.email')}
              icon={Mail01Icon}
              optional
              type="email"
              placeholder="accounts@rahmangarments.com"
              {...register('email')}
              error={errors.email?.message}
            />
            <div className="sm:col-span-2">
              <TextAreaField
                label={t('settings.address')}
                optional
                placeholder="Plot 12, BSCIC Industrial Area, Konabari, Gazipur 1751"
                {...register('address')}
                error={errors.address?.message}
              />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={t('settings.regionalTitle')}
            subtitle={t('settings.regionalSubtitle')}
          />
          <div className="grid gap-5 p-5 sm:grid-cols-2 sm:gap-x-4">
            <SelectField
              label={t('settings.baseCurrency')}
              icon={Money03Icon}
              hint={t('settings.baseCurrencyHint')}
              options={CURRENCY_OPTIONS}
              {...register('baseCurrency')}
              error={errors.baseCurrency?.message}
            />
            <SelectField
              label={t('settings.fiscalYearStart')}
              icon={Calendar03Icon}
              hint={t('settings.fiscalYearHint')}
              options={monthOptions}
              // select-এর মান সবসময় string; valueAsNumber ছাড়া schema "7"-কে সংখ্যা মানত না
              {...register('fiscalYearStartMonth', { valueAsNumber: true })}
              error={errors.fiscalYearStartMonth?.message}
            />
            <SelectField
              label={t('settings.timezone')}
              icon={Globe02Icon}
              options={zoneOptions}
              {...register('timezone')}
              error={errors.timezone?.message}
            />
          </div>
        </Card>
      </fieldset>

      {canManage ? (
        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={isSubmitting || !isDirty}
            className="w-full sm:w-auto sm:min-w-40"
          >
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      ) : (
        <p className="text-body-sm text-ink-3">{t('settings.readOnly')}</p>
      )}
    </form>
  );
}

// ব্রাউজারের নিজের ব্যর্থতাও (ভুল ধরনের ফাইল, storage-এ PUT ব্যর্থ) API-র error-এর একই আকারে —
// তাহলে দেখানোর কোড একটাই: error.code → বর্তমান ভাষায় লেখা
function uploadError(code: ErrorCode): ApiRequestError {
  return new ApiRequestError({ title: 'Upload failed', status: 0, detail: code, code });
}

// চার ধাপ: (১) ফাইলের বর্ণনা যাচাই → সই করা ঠিকানা, (২) ফাইল সরাসরি storage-এ, (৩) সার্ভার যাচাই
// করে "ready", (৪) লোগো হিসেবে বসানো। ফাইল কখনো API সার্ভার দিয়ে যায় না
async function uploadLogo(file: File): Promise<Settings> {
  const described = createUploadInputSchema.safeParse(
    { purpose: 'company_logo', fileName: file.name, contentType: file.type, sizeBytes: file.size },
    { error: contractErrorMap },
  );
  if (!described.success) {
    const message = described.error.issues[0]?.message;
    throw uploadError(isErrorCode(message) ? message : 'invalid_value');
  }
  const ticket = await call(routes.attachments.createUpload, { body: described.data });
  // আমাদের API না, storage — তাই call() না, সাধারণ fetch। সই করা header হুবহু পাঠাতে হয়
  const put = await fetch(ticket.upload.url, {
    method: ticket.upload.method,
    headers: ticket.upload.headers,
    body: file,
  }).catch(() => null);
  if (!put?.ok) throw uploadError('upload_incomplete');
  await call(routes.attachments.complete, { params: { id: ticket.attachment.id } });
  return call(routes.settings.setLogo, { body: { attachmentId: ticket.attachment.id } });
}

function LogoCard({ settings, canManage }: { settings: Settings; canManage: boolean }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const saved = (next: Settings, message: string) => {
    queryClient.setQueryData(settingsQuery(tenantId).queryKey, next);
    toast(message);
  };
  const upload = useMutation({
    mutationFn: uploadLogo,
    onSuccess: (next) => {
      saved(next, t('settings.logoSaved'));
    },
  });
  const remove = useMutation({
    mutationFn: () => call(routes.settings.setLogo, { body: { attachmentId: null } }),
    onSuccess: (next) => {
      saved(next, t('settings.logoRemoved'));
    },
  });
  const failure = upload.error ?? remove.error;
  const busy = upload.isPending || remove.isPending;

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // খালি করা: একই ফাইল আবার বাছলেও change ঘটে (যেমন ব্যর্থ আপলোডের পরে আবার চেষ্টা)
    event.target.value = '';
    if (file) upload.mutate(file);
  };

  return (
    <Card>
      <CardHeader title={t('settings.logoTitle')} subtitle={t('settings.logoSubtitle')} />
      <div className="flex flex-wrap items-center gap-4 p-5">
        <div className="flex h-20 w-40 shrink-0 items-center justify-center overflow-hidden rounded-control border border-line bg-subtle p-2">
          {settings.logo ? (
            <img
              src={settings.logo.url}
              alt={t('settings.logoAlt', { name: settings.companyName })}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <span className="grid justify-items-center gap-1 text-caption text-ink-3">
              <HugeiconsIcon icon={Image01Icon} size={18} strokeWidth={1.5} />
              {t('settings.noLogo')}
            </span>
          )}
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInput}
              type="file"
              // ফাইল বাছার জানালায় শুধু অনুমোদিত ধরন দেখায় — নিয়ম contracts থেকে, সার্ভারও একই নিয়ম মানে
              accept={ATTACHMENT_RULES.company_logo.contentTypes.join(',')}
              className="sr-only"
              tabIndex={-1}
              onChange={choose}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {upload.isPending
                ? t('settings.uploading')
                : settings.logo
                  ? t('settings.replaceLogo')
                  : t('settings.uploadLogo')}
            </Button>
            {settings.logo && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  remove.mutate();
                }}
              >
                {t('settings.removeLogo')}
              </Button>
            )}
          </div>
        )}
        {failure && (
          <div className="basis-full">
            <FormAlert
              message={failure instanceof ApiRequestError ? failure.code : 'unknown_error'}
            />
          </div>
        )}
      </div>
    </Card>
  );
}

export function SettingsPage() {
  const { t } = useLocale();
  const can = useCan();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const { data, isError } = useQuery({ ...settingsQuery(tenantId), enabled: me !== null });
  if (!me) return null;

  const canManage = can('core.settings.manage');

  return (
    <div className="grid max-w-3xl gap-5">
      <PageHeader title={t('settings.title')} description={t('settings.description')} />
      {isError && <p className="text-body-sm text-crit">{t('settings.loadFailed')}</p>}
      {data && (
        <>
          <LogoCard settings={data} canManage={canManage} />
          {/* key: workspace বদলালে নতুন টেন্যান্টের মান দিয়ে ফর্ম নতুন করে তৈরি; একই টেন্যান্টের
              refetch-এ না — তাহলে লেখার মাঝে ফর্ম মুছে যেত */}
          <SettingsForm key={tenantId} settings={data} canManage={canManage} />
        </>
      )}
    </div>
  );
}
