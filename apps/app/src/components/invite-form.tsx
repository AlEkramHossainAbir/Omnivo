import { Mail01Icon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  createInvitationInputSchema,
  type Invitation,
  type MeResponse,
  type Role,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  CheckboxGroup,
  type CheckboxOption,
  DialogClose,
  DialogContent,
  FormAlert,
  TextField,
  toast,
} from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rolesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// The invite dialog and its role list — shared by the team page and the onboarding wizard's last
// step (moved out of routes/team.tsx in step 8, unchanged apart from the toast and onInvited)
const INVITE_FIELDS = createInvitationInputSchema.keyof().options;

// এই রোল আমি দিতে (বা কেড়ে নিতে) পারি কি না — API-র grants.ts-এর একই নিয়ম, শুধু আগেভাগে বাক্সটা বন্ধ
// রাখার জন্য। owner-কে owner চেনা যায় me.roles-এ owner রোলের নাম দেখে (সেই নাম বদলানো যায় না)
function useGrantable(roles: readonly Role[] | undefined, me: MeResponse | null) {
  return useCallback(
    (role: Role): 'ok' | 'ownerOnly' | 'cantGrant' => {
      if (!me || !roles) return 'cantGrant';
      const ownerName = roles.find((candidate) => candidate.kind === 'owner')?.name;
      if (ownerName !== undefined && me.roles.includes(ownerName)) return 'ok';
      if (role.kind === 'owner') return 'ownerOnly';
      return role.permissions.every((key) => me.permissions.includes(key)) ? 'ok' : 'cantGrant';
    },
    [roles, me],
  );
}

// invite আর সদস্যের ফর্ম — দুটোতেই একই রোলের তালিকা: নাম, নিচে কী দেয়, আর দিতে না পারলে কেন
export function useRoleOptions(roles: readonly Role[] | undefined): CheckboxOption[] {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const grantable = useGrantable(roles, me);
  return useMemo(
    () =>
      (roles ?? []).map((role) => {
        const verdict = grantable(role);
        const detail =
          verdict === 'ownerOnly'
            ? t('team.ownerOnly')
            : verdict === 'cantGrant'
              ? t('team.cantGrant')
              : role.kind === 'owner'
                ? t('team.allPermissions')
                : t('team.permissionCount', { count: role.permissions.length });
        return {
          value: role.id,
          disabled: verdict !== 'ok',
          label: (
            <span className="grid">
              <span className="font-medium text-ink">{role.name}</span>
              <span className="text-caption text-ink-3">{detail}</span>
            </span>
          ),
        };
      }),
    [roles, grantable, t],
  );
}

interface InviteFormProps {
  onDone: () => void;
  // Called with the new invitation — the wizard lists who it has invited so far
  onInvited?: (invitation: Invitation) => void;
}

export function InviteForm({ onDone, onInvited }: InviteFormProps) {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const queryClient = useQueryClient();
  const { data: roles } = useQuery(rolesQuery(tenantId));
  const options = useRoleOptions(roles);
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(createInvitationInputSchema, { error: contractErrorMap }),
    defaultValues: { email: '', roleIds: [] },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const invitation = await call(routes.invitations.create, { body: values });
      await queryClient.invalidateQueries({ queryKey: ['invitations', tenantId] });
      // "Sending", not "sent": the worker sends it a moment later. The list shows how it ends.
      toast(t('team.invited', { email: invitation.email }));
      onInvited?.(invitation);
      onDone();
    } catch (error) {
      applyApiError(error, INVITE_FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={t('team.inviteTitle')}
      description={t('team.inviteDescription', { workspace: me?.tenant.name ?? '' })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="invite-form" disabled={isSubmitting}>
            {isSubmitting ? t('team.sending') : t('team.send')}
          </Button>
        </>
      }
    >
      <form
        id="invite-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <TextField
          label={t('team.email')}
          icon={Mail01Icon}
          type="email"
          autoComplete="off"
          placeholder="tanvir@rahmangarments.com"
          {...register('email')}
          error={errors.email?.message}
        />
        {/* Radix Checkbox আসল <input> না, তাই register চলে না — Controller মান আর onChange জোড়ে */}
        <Controller
          control={control}
          name="roleIds"
          render={({ field }) => (
            <CheckboxGroup
              legend={t('team.roles')}
              hint={t('team.rolesHint')}
              options={options}
              value={field.value}
              onChange={field.onChange}
              error={errors.roleIds?.message}
            />
          )}
        />
      </form>
    </DialogContent>
  );
}
