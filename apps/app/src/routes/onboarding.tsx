import {
  Building03Icon,
  Call02Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  DeliveryTruck01Icon,
  Factory01Icon,
  IdentityCardIcon,
  Mail01Icon,
  Medicine02Icon,
  Store01Icon,
  TShirtIcon,
  UserAdd01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type Industry,
  INDUSTRIES,
  type Invitation,
  routes,
  type Settings,
  updateSettingsInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Dialog,
  FormAlert,
  Logo,
  Pill,
  SelectableCardGroup,
  Stepper,
  TextAreaField,
  TextField,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { InviteForm } from '../components/invite-form';
import { LanguageSwitch } from '../components/language-switch';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rolesQuery, settingsQuery, setupQuery } from '../lib/queries';
import { refreshMe } from '../lib/session';
import { useSession } from '../lib/session-store';
import { settingsToForm } from '../lib/settings-form';

// One icon per business type. satisfies: a new industry in contracts does not compile without one.
const INDUSTRY_ICON = {
  garments: TShirtIcon,
  pharma: Medicine02Icon,
  distribution: DeliveryTruck01Icon,
  manufacturing: Factory01Icon,
  retail: Store01Icon,
  other: Building03Icon,
} satisfies Record<Industry, IconSvgElement>;

const STEPS = ['business', 'company', 'team'] as const;
type Step = 0 | 1 | 2;
const SETTINGS_FIELDS = updateSettingsInputSchema.keyof().options;

// The wizard's white panel: title, text, content and a button row under a rule, like sign-up
function Panel({
  step,
  title,
  subtitle,
  children,
  footer,
}: {
  step: Step;
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  const { t } = useLocale();
  return (
    <div className="rounded-card border border-line bg-surface px-[18px] py-[22px] shadow-md sm:p-8">
      <p className="text-caption text-ink-3">
        {t('onboarding.stepOf', { current: step + 1, total: STEPS.length })}
      </p>
      <h1 className="mt-1 text-h2">{title}</h1>
      <p className="mt-1.5 text-ink-2">{subtitle}</p>
      <div className="mt-7">{children}</div>
      <div className="mt-8 flex flex-wrap items-center justify-end gap-3 border-t border-line pt-6">
        {footer}
      </div>
    </div>
  );
}

function BusinessStep({ onDone }: { onDone: () => void }) {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const queryClient = useQueryClient();
  const [industry, setIndustry] = useState<Industry | null>(null);

  const options = useMemo(
    () =>
      INDUSTRIES.map((value) => ({
        value,
        icon: INDUSTRY_ICON[value],
        title: t(`onboarding.industries.${value}.name`),
        description: t(`onboarding.industries.${value}.description`),
      })),
    [t],
  );

  const start = useMutation({
    mutationFn: (picked: Industry) => call(routes.setup.start, { body: { industry: picked } }),
    onSuccess: async (setup) => {
      // The answer is the new status ('provisioning'): put it in the cache so the last step starts
      // polling from here, without a first request of its own
      queryClient.setQueryData(setupQuery(tenantId).queryKey, setup);
      // me.tenant.setupStatus is no longer 'pending' — otherwise the router would send us back here
      await refreshMe();
      onDone();
    },
  });

  return (
    <Panel
      step={0}
      title={t('onboarding.business.title', { company: me?.tenant.name ?? '' })}
      subtitle={t('onboarding.business.subtitle')}
      footer={
        <Button
          disabled={industry === null || start.isPending}
          onClick={() => {
            if (industry !== null) start.mutate(industry);
          }}
          className="w-full sm:w-auto sm:min-w-40"
        >
          {start.isPending ? t('onboarding.starting') : t('onboarding.continue')}
        </Button>
      }
    >
      <div className="grid gap-5">
        {start.error && (
          <FormAlert
            message={start.error instanceof ApiRequestError ? start.error.code : 'unknown_error'}
          />
        )}
        <SelectableCardGroup
          legend={t('onboarding.business.label')}
          options={options}
          value={industry}
          onChange={setIndustry}
        />
      </div>
    </Panel>
  );
}

function CompanyForm({ settings, onDone }: { settings: Settings; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  // The full settings form, showing four of its fields: the rest (currency, fiscal year…) ride
  // along from settingsToForm unchanged, because PUT /settings takes the whole profile
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateSettingsInputSchema, { error: contractErrorMap }),
    defaultValues: settingsToForm(settings),
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.settings.update, { body: values });
      queryClient.setQueryData(settingsQuery(tenantId).queryKey, saved);
      onDone();
    } catch (error) {
      applyApiError(error, SETTINGS_FIELDS, setError);
    }
  });

  return (
    <Panel
      step={1}
      title={t('onboarding.company.title')}
      subtitle={t('onboarding.company.subtitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onDone}>
            {t('onboarding.skip')}
          </Button>
          <Button
            type="submit"
            form="company-form"
            disabled={isSubmitting}
            className="w-full sm:w-auto sm:min-w-40"
          >
            {isSubmitting ? t('common.saving') : t('onboarding.continue')}
          </Button>
        </>
      }
    >
      <form
        id="company-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5 sm:grid-cols-2 sm:gap-x-4"
      >
        {errors.root?.server?.message && (
          <div className="sm:col-span-2">
            <FormAlert message={errors.root.server.message} />
          </div>
        )}
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
        <div className="sm:col-span-2">
          <TextAreaField
            label={t('settings.address')}
            optional
            placeholder="Plot 12, BSCIC Industrial Area, Konabari, Gazipur 1751"
            {...register('address')}
            error={errors.address?.message}
          />
        </div>
      </form>
    </Panel>
  );
}

function CompanyStep({ onDone }: { onDone: () => void }) {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const { data: settings } = useQuery(settingsQuery(tenantId));
  // The form needs the settings' version (optimistic locking), so it waits for them. The key
  // makes a fresh form if another version ever arrives.
  if (!settings) return null;
  return <CompanyForm key={settings.version} settings={settings} onDone={onDone} />;
}

// Where the background job is, in words and a pill — the build plan's "job status"
function SetupProgress() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const { data: setup } = useQuery(setupQuery(tenantId));
  const ready = setup?.status === 'ready';
  const { data: roles } = useQuery({ ...rolesQuery(tenantId), enabled: ready });

  const retry = useMutation({
    mutationFn: () => call(routes.setup.retry),
    onSuccess: (next) => {
      queryClient.setQueryData(setupQuery(tenantId).queryKey, next);
    },
  });

  if (!setup) return null;
  const industry = setup.industry === null ? '' : t(`onboarding.industries.${setup.industry}.name`);

  if (setup.status === 'failed') {
    return (
      <div className="grid gap-3">
        <FormAlert message={t('onboarding.team.failed')} />
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={retry.isPending}
            onClick={() => {
              retry.mutate();
            }}
          >
            {t('onboarding.team.retry')}
          </Button>
        </div>
      </div>
    );
  }
  // role="status": a screen reader announces the change from "Preparing…" to "Roles ready"
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 text-body-sm text-ink-2">
      {ready ? (
        <>
          <Pill tone="good" icon={CheckmarkCircle02Icon}>
            {industry}
          </Pill>
          {t('onboarding.team.ready', {
            roles: (roles ?? [])
              .filter((role) => role.kind === 'custom')
              .map((role) => role.name)
              .join(', '),
          })}
        </>
      ) : (
        <>
          <Pill tone="neutral" icon={Clock01Icon}>
            {industry}
          </Pill>
          {t('onboarding.team.preparing', { industry })}
        </>
      )}
    </p>
  );
}

function TeamStep() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const { data: setup } = useQuery(setupQuery(tenantId));
  const [inviting, setInviting] = useState(false);
  const [invited, setInvited] = useState<Invitation[]>([]);

  return (
    <Panel
      step={2}
      title={t('onboarding.team.title')}
      subtitle={t('onboarding.team.subtitle')}
      footer={
        <Button onClick={() => void navigate({ to: '/' })} className="w-full sm:w-auto sm:min-w-40">
          {t('onboarding.team.finish')}
        </Button>
      }
    >
      <div className="grid gap-5">
        <SetupProgress />
        <div>
          {/* The template's roles are what people get invited to: wait until they exist */}
          <Button
            variant="secondary"
            disabled={setup?.status !== 'ready'}
            onClick={() => {
              setInviting(true);
            }}
          >
            <HugeiconsIcon icon={UserAdd01Icon} size={17} strokeWidth={1.5} />
            {t('onboarding.team.invite')}
          </Button>
        </div>
        {invited.length > 0 && (
          <section className="grid gap-2">
            <h2 className="text-label font-medium text-ink">{t('onboarding.team.invited')}</h2>
            <ul className="grid gap-1.5">
              {invited.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex min-w-0 items-center gap-2 text-body-sm text-ink-2"
                >
                  <HugeiconsIcon
                    icon={Mail01Icon}
                    size={16}
                    strokeWidth={1.5}
                    className="shrink-0 text-ink-3"
                  />
                  <span className="truncate">{invitation.email}</span>
                  <span className="shrink-0 text-ink-3">
                    · {invitation.roles.map((role) => role.name).join(', ')}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <Dialog open={inviting} onOpenChange={setInviting}>
        {inviting && (
          <InviteForm
            onDone={() => {
              setInviting(false);
            }}
            onInvited={(invitation) => {
              setInvited((list) => [...list, invitation]);
            }}
          />
        )}
      </Dialog>
    </Panel>
  );
}

// Full page, outside the app shell: nothing else to click until the business type is chosen.
// The router sends an owner here while the setup is 'pending' (router.tsx).
export function OnboardingPage() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  // Coming back after step 1 (a reload, or a later visit): start at the company step. The type
  // is picked once, so step 1 is never shown again.
  const [step, setStep] = useState<Step>(() => (me?.tenant.setupStatus === 'pending' ? 0 : 1));
  if (!me) return null;

  return (
    <div className="min-h-dvh">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-surface px-4 py-5 sm:px-10">
        <Logo />
        <LanguageSwitch />
      </header>
      <main className="mx-auto grid max-w-[720px] gap-6 px-4 pt-10 pb-16">
        <Stepper
          label={t('onboarding.stepsLabel')}
          steps={STEPS.map((name) => t(`onboarding.steps.${name}`))}
          current={step}
        />
        {step === 0 && (
          <BusinessStep
            onDone={() => {
              setStep(1);
            }}
          />
        )}
        {step === 1 && (
          <CompanyStep
            onDone={() => {
              setStep(2);
            }}
          />
        )}
        {/* A failed job shows up here, with its Retry button (SetupProgress) */}
        {step === 2 && <TeamStep />}
      </main>
    </div>
  );
}
