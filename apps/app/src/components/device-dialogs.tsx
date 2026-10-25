import { zodResolver } from '@hookform/resolvers/zod';
import { ComputerPhoneSyncIcon, Store01Icon } from '@hugeicons/core-free-icons';
import {
  contractErrorMap,
  type DeviceListItem,
  moveDeviceInputSchema,
  renameDeviceInputSchema,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { useStore } from 'zustand';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { localDataStore } from '../lib/local-data';
import { branchesQuery } from '../lib/queries';
import { useSyncSummary } from '../lib/sync-summary';
import { useOnline } from '../lib/use-online';
import type { DeviceAction } from './device-parts';
import { DocumentNotice } from './document-notice';
import { useTenantId } from '../lib/workspace';

// Step 18c: the three actions of a device row, each its own dialog content inside one Dialog.

// After a rename, a move or a revoke: both lists (queries.ts: ['devices', tenantId])
export function useDevicesRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['devices', tenantId] }),
    [queryClient, tenantId],
  );
}

const RENAME_FIELDS = renameDeviceInputSchema.keyof().options;
const MOVE_FIELDS = moveDeviceInputSchema.keyof().options;

function RenameForm({ device, onDone }: { device: DeviceListItem; onDone: () => void }) {
  const { t } = useLocale();
  const refresh = useDevicesRefresh();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(renameDeviceInputSchema, { error: contractErrorMap }),
    // The version the person saw (decision 9): two people renaming the same device, the second is
    // told (version_conflict, at the top of the form)
    defaultValues: { name: device.name, version: device.version },
  });

  const onSubmit = handleSubmit(async (body) => {
    try {
      const saved = await call(routes.devices.rename, { params: { id: device.id }, body });
      await refresh();
      toast(t('devices.renamed', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, RENAME_FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={t('devices.renameTitle', { name: device.name })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="rename-device-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('devices.saveName')}
          </Button>
        </>
      }
    >
      <form
        id="rename-device-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <TextField
          label={t('devices.name')}
          icon={ComputerPhoneSyncIcon}
          hint={t('devices.nameHint')}
          autoComplete="off"
          {...register('name')}
          error={errors.name?.message}
        />
      </form>
    </DialogContent>
  );
}

// Change branch, on this device only (decision 2). Online, and with nothing in the outbox: the
// dialog says why not instead of a form that would fail, and points to the Sync page, where the
// waiting changes are sent or discarded. The count is live (the sidebar's), so the form comes as
// soon as the last change is sent.
function MoveForm({ device, onDone }: { device: DeviceListItem; onDone: () => void }) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const { waiting } = useSyncSummary();
  const moveHere = useStore(localDataStore, (state) => state.moveHere);
  const refresh = useDevicesRefresh();
  const branches = useQuery(branchesQuery(tenantId, 'active')).data ?? [];
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(moveDeviceInputSchema, { error: contractErrorMap }),
    // No branch chosen for the person, like the first branch dialog (18a)
    defaultValues: { branchId: '', version: device.version },
  });
  const ready = online && waiting === 0;

  const onSubmit = handleSubmit(async (body) => {
    try {
      const moved = await moveHere(body);
      // Something was saved since the dialog opened: the count above turns the form into the
      // "sync first" line by itself
      if (moved === 'waiting') return;
      await refresh();
      toast(t('devices.moved', { branch: moved.branchName }));
      onDone();
    } catch (error) {
      applyApiError(error, MOVE_FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={t('devices.changeBranchTitle')}
      description={t('devices.changeBranchBody', { branch: device.branchName })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="move-device-form" disabled={!ready || isSubmitting}>
            {isSubmitting ? t('common.saving') : t('devices.changeBranchConfirm')}
          </Button>
        </>
      }
    >
      {!online ? (
        <DocumentNotice tone="neutral">{t('devices.changeBranchOffline')}</DocumentNotice>
      ) : waiting > 0 ? (
        <DocumentNotice tone="neutral">
          {t('devices.changeBranchSyncFirst', {
            count: waiting,
            formatted: format.number(waiting),
          })}{' '}
          <Link
            to="/sync"
            className="font-medium text-brand underline-offset-3 hover:underline"
            onClick={onDone}
          >
            {t('nav.sync')}
          </Link>
        </DocumentNotice>
      ) : (
        <form
          id="move-device-form"
          noValidate
          onSubmit={(event) => void onSubmit(event)}
          className="grid gap-5"
        >
          {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
          <SelectField
            label={t('devices.newBranch')}
            icon={Store01Icon}
            options={[
              { value: '', label: t('devices.branchPlaceholder') },
              // Its own branch is not a choice: moving there changes nothing
              ...branches
                .filter((branch) => branch.id !== device.branchId)
                .map((branch) => ({ value: branch.id, label: `${branch.code} · ${branch.name}` })),
            ]}
            {...register('branchId')}
            error={errors.branchId?.message}
          />
        </form>
      )}
    </DialogContent>
  );
}

// Revoke (decisions 3 and 4). Two texts: a device somewhere else stops at once and loses its copy
// the next time it opens; this device signs you out here, and says how many changes are lost. Both
// say it is final. No version (decision 9).
function RevokeContent({
  device,
  here,
  onDone,
}: {
  device: DeviceListItem;
  here: boolean;
  onDone: () => void;
}) {
  const { t, format, errorText } = useLocale();
  const { waiting } = useSyncSummary();
  const revokedHere = useStore(localDataStore, (state) => state.revokedHere);
  const refresh = useDevicesRefresh();
  const revoke = useMutation({
    mutationFn: () => call(routes.devices.revoke, { params: { id: device.id } }),
    onSuccess: async (saved) => {
      // This device: the copy goes, then the sign-out (local-session.ts); the page goes with it
      if (here) {
        await revokedHere();
        return;
      }
      await refresh();
      toast(t('devices.revoked', { name: saved.name }));
      onDone();
    },
  });
  const failure = revoke.error
    ? revoke.error instanceof ApiRequestError
      ? revoke.error.code
      : 'unknown_error'
    : null;

  return (
    <DialogContent
      title={t('devices.revokeTitle', { name: device.name })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            disabled={revoke.isPending}
            onClick={() => {
              revoke.mutate();
            }}
          >
            {t('devices.revokeConfirm')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-body-sm text-ink-2">
        {failure !== null && <p className="text-crit">{errorText(failure)}</p>}
        <p>
          {here ? t('devices.revokeHereBody') : t('devices.revokeBody')}
          {here &&
            waiting > 0 &&
            ` ${t('devices.revokeHereWaiting', {
              count: waiting,
              formatted: format.number(waiting),
            })}`}
        </p>
        <p>{t('devices.revokeFinal')}</p>
      </div>
    </DialogContent>
  );
}

// The page keeps what the menu asked for; null = no dialog. `key` per device and action: a new
// action opens a new form, never the last one's values.
export function DeviceDialogs({
  acting,
  thisDeviceId,
  onClose,
}: {
  acting: DeviceAction | null;
  thisDeviceId: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={acting !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {acting?.kind === 'rename' && (
        <RenameForm key={`rename-${acting.device.id}`} device={acting.device} onDone={onClose} />
      )}
      {acting?.kind === 'move' && (
        <MoveForm key={`move-${acting.device.id}`} device={acting.device} onDone={onClose} />
      )}
      {acting?.kind === 'revoke' && (
        <RevokeContent
          key={`revoke-${acting.device.id}`}
          device={acting.device}
          here={acting.device.id === thisDeviceId}
          onDone={onClose}
        />
      )}
    </Dialog>
  );
}
