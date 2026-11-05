import { PlusSignIcon, SecurityCheckIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  isPermissionKey,
  PERMISSION_GROUP_OF,
  PERMISSION_GROUPS,
  PERMISSION_KEYS,
  type PermissionKey,
  type Role,
  routes,
  updateRoleInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  PageHeader,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { rolesQuery } from '../lib/queries';
import { refreshMe } from '../lib/session';
import { useSession } from '../lib/session-store';

const ROLE_FIELDS = updateRoleInputSchema.keyof().options;

// তারে permission z.string() (নতুন সার্ভারের নতুন key) — ছকে শুধু এই app যেগুলো চেনে
function knownKeys(role: Role): PermissionKey[] {
  return role.permissions.filter(isPermissionKey);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key) => b.includes(key));
}

function failureOf(error: Error | null): string | undefined {
  if (!error) return undefined;
  return error instanceof ApiRequestError ? error.code : 'unknown_error';
}

// একটা ফর্ম দুই কাজে: নতুন রোল (role নেই) আর নাম/বিবরণ বদল। নতুনের version 1 — schema-র min(1) পার
// হয়, আর তৈরির route version পড়েই না (branches.tsx-এর একই কৌশল)
function RoleForm({ role, onDone }: { role: Role | null; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateRoleInputSchema, { error: contractErrorMap }),
    defaultValues: {
      name: role?.name ?? '',
      description: role?.description ?? '',
      version: role?.version ?? 1,
    },
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['roles', tenantId] });

  const remove = useMutation({
    mutationFn: (current: Role) =>
      call(routes.roles.remove, {
        params: { id: current.id },
        query: { version: current.version },
      }),
    onSuccess: async (_, current) => {
      await refresh();
      toast(t('roles.deleted', { name: current.name }));
      onDone();
    },
  });

  const onSubmit = handleSubmit(async ({ version, ...fields }) => {
    try {
      const saved = role
        ? await call(routes.roles.update, { params: { id: role.id }, body: { ...fields, version } })
        : await call(routes.roles.create, { body: fields });
      await refresh();
      // রোলের নাম me.roles-এ — নিজের রোলের নাম বদলালে সাইডবারের নিচেও নতুন নাম
      if (role) await refreshMe();
      toast(t(role ? 'roles.updated' : 'roles.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, ROLE_FIELDS, setError);
    }
  });

  const failure = errors.root?.server?.message ?? failureOf(remove.error);

  return (
    <DialogContent
      title={role ? t('roles.editTitle', { name: role.name }) : t('roles.newTitle')}
      description={role ? undefined : t('roles.newDescription')}
      footer={
        <>
          {role && (
            // বাঁয়ে আর দুই ধাপে — মুছে ফেলা ফেরানো যায় না
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={remove.isPending}
              onClick={() => {
                if (confirming) remove.mutate(role);
                else setConfirming(true);
              }}
            >
              {confirming ? t('roles.confirmDelete', { name: role.name }) : t('roles.delete')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="role-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : role ? t('common.save') : t('roles.create')}
          </Button>
        </>
      }
    >
      <form
        id="role-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        {confirming && <p className="text-body-sm text-ink-2">{t('roles.deleteWarning')}</p>}
        <TextField
          label={t('roles.name')}
          icon={SecurityCheckIcon}
          placeholder={t('roles.namePlaceholder')}
          {...register('name')}
          error={errors.name?.message}
        />
        <TextAreaField
          label={t('roles.about')}
          optional
          placeholder={t('roles.aboutPlaceholder')}
          {...register('description')}
          error={errors.description?.message}
        />
      </form>
    </DialogContent>
  );
}

export function RolesPage() {
  const { t } = useLocale();
  const can = useCan();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const queryClient = useQueryClient();
  const canManage = can('core.role.manage');
  const { data: roles, isError } = useQuery({ ...rolesQuery(tenantId), enabled: me !== null });
  // শুধু বদলানো রোলগুলো: রোলের id → নতুন পুরো তালিকা। সেভ না হওয়া পর্যন্ত সার্ভারের ডেটা অক্ষত, তাই
  // "Discard" মানে শুধু এই object খালি করা
  const [draft, setDraft] = useState<Record<string, PermissionKey[]>>({});
  const [editing, setEditing] = useState<null | 'new' | Role>(null);

  const ownerName = roles?.find((role) => role.kind === 'owner')?.name;
  const iAmOwner = ownerName !== undefined && (me?.roles.includes(ownerName) ?? false);
  // API-র নিয়মের আগাম ছায়া (grants.ts): নিজের যা আছে শুধু সেই ঘরে টিক বদলানো যায়
  const canTick = (key: PermissionKey) =>
    canManage && (iAmOwner || (me?.permissions.includes(key) ?? false));

  const current = (role: Role) => draft[role.id] ?? knownKeys(role);
  const changed = Object.keys(draft);

  const toggle = (role: Role, key: PermissionKey, on: boolean) => {
    setDraft((previous) => {
      const base = previous[role.id] ?? knownKeys(role);
      const next = on ? [...base, key] : base.filter((existing) => existing !== key);
      const rest = Object.fromEntries(Object.entries(previous).filter(([id]) => id !== role.id));
      // আগের অবস্থায় ফিরে এলে "বদলানো" তালিকা থেকেও বাদ — না হলে কিছু না বদলেও সেভ-বার দেখাত
      return sameSet(next, knownKeys(role)) ? rest : { ...rest, [role.id]: next };
    });
  };

  const save = useMutation({
    mutationFn: () =>
      call(routes.roles.updateMatrix, {
        body: {
          roles: changed.flatMap((id) => {
            const role = roles?.find((candidate) => candidate.id === id);
            const permissions = draft[id];
            return role && permissions ? [{ id, version: role.version, permissions }] : [];
          }),
        },
      }),
    onSuccess: async (result) => {
      // উত্তরেই পুরো নতুন তালিকা — আরেকটা GET লাগে না
      queryClient.setQueryData(rolesQuery(tenantId).queryKey, result.items);
      setDraft({});
      // আমার নিজের কোনো রোল বদলে থাকলে মেনুর লিংকও বদলায় (me.permissions)
      await refreshMe();
      toast(t('roles.saved'));
    },
  });

  return (
    <div className="grid max-w-6xl gap-5">
      <PageHeader
        title={t('roles.title')}
        description={t('roles.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('roles.add')}
            </Button>
          )
        }
      />
      {!canManage && <p className="text-body-sm text-ink-3">{t('roles.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('roles.loadFailed')}</p>}
      {save.error && <FormAlert message={failureOf(save.error) ?? 'unknown_error'} />}

      {roles && (
        // চওড়া ছক নিজের বাক্সে আড়াআড়ি scroll করে, পেজ না (CLAUDE.md → Page gutters)। min-w-0 বাধ্যতামূলক:
        // grid-এর সন্তানের ডিফল্ট min-width: auto = ভেতরের জিনিসের চওড়া, তাই এটা ছাড়া বাক্স ছকের সমান চওড়া
        // হয়ে পুরো পেজকে ফোনে আড়াআড়ি ঠেলত। প্রথম কলাম sticky — ডানে scroll করলেও সারির নাম চোখে থাকে
        <div className="min-w-0 overflow-x-auto rounded-card border border-line bg-surface shadow-sm">
          <table className="w-full border-collapse text-body-sm">
            <caption className="sr-only">{t('roles.matrixLabel')}</caption>
            <thead>
              <tr className="bg-subtle">
                <th
                  scope="col"
                  className="sticky left-0 z-10 min-w-[220px] bg-subtle px-5 py-3 text-left text-caption font-medium text-ink-3"
                >
                  {t('roles.permission')}
                </th>
                {roles.map((role) => (
                  <th
                    key={role.id}
                    scope="col"
                    className="min-w-[120px] px-4 py-3 text-center align-bottom font-normal"
                  >
                    {canManage && role.kind === 'custom' ? (
                      <button
                        type="button"
                        aria-label={t('roles.edit', { role: role.name })}
                        onClick={() => {
                          setEditing(role);
                        }}
                        className="rounded-lg px-1.5 py-0.5 font-semibold text-ink transition-colors duration-150 hover:bg-surface hover:text-brand"
                      >
                        {role.name}
                      </button>
                    ) : (
                      <span className="font-semibold text-ink">{role.name}</span>
                    )}
                    <span className="block text-caption text-ink-3 tabular-nums">
                      {t('roles.members', { count: role.memberCount })}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            {PERMISSION_GROUPS.map((group) => (
              <tbody key={group}>
                <tr>
                  <th
                    scope="colgroup"
                    colSpan={roles.length + 1}
                    className="sticky left-0 bg-surface px-5 pt-4 pb-1 text-left text-caption font-medium text-ink-3"
                  >
                    {t(`roles.groups.${group}`)}
                  </th>
                </tr>
                {PERMISSION_KEYS.filter((key) => PERMISSION_GROUP_OF[key] === group).map((key) => (
                  <tr key={key} className="border-t border-line">
                    <th
                      scope="row"
                      className="sticky left-0 z-10 bg-surface px-5 py-3 text-left font-normal"
                    >
                      <span className="block text-ink">{t(`permissions.${key}`)}</span>
                      {/* key-টাও: permission_missing-এর লেখা ("core.audit.read লাগবে") এখানে মেলানো যায় */}
                      <span className="block font-mono text-caption text-ink-3">{key}</span>
                    </th>
                    {roles.map((role) => (
                      <td key={role.id} className="px-4 py-3">
                        <div className="grid place-items-center">
                          <Checkbox
                            id={`${role.id}-${key}`}
                            hideLabel
                            label={t('roles.cell', {
                              role: role.name,
                              permission: t(`permissions.${key}`),
                            })}
                            // owner-এর ঘর সবসময় টিক আর বন্ধ — অধিকার কোডে, ছকে বদলানোর কিছু নেই
                            checked={role.kind === 'owner' || current(role).includes(key)}
                            disabled={role.kind === 'owner' || !canTick(key) || save.isPending}
                            onCheckedChange={(checked) => {
                              toggle(role, key, checked === true);
                            }}
                          />
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
      <p className="text-label text-ink-3">{t('roles.ownerLocked')}</p>

      {changed.length > 0 && (
        // সেভ-বার পেজের নিচে লেগে থাকে (sticky) — লম্বা ছকের যেখানেই থাকুন, বাটন হাতের কাছে
        <div className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface px-5 py-3 shadow-md">
          <p className="text-body-sm text-ink-2">{t('roles.unsaved', { count: changed.length })}</p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={save.isPending}
              onClick={() => {
                setDraft({});
                save.reset();
                // version_conflict-এর পরে এটাই "Reload": আরেকজনের সেভ করা ছক সার্ভার থেকে আবার আনা
                void queryClient.invalidateQueries({ queryKey: rolesQuery(tenantId).queryKey });
              }}
            >
              {t('roles.discard')}
            </Button>
            <Button
              disabled={save.isPending}
              onClick={() => {
                save.mutate();
              }}
            >
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing !== null && (
          <RoleForm
            key={editing === 'new' ? 'new' : editing.id}
            role={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
