import { zodResolver } from '@hookform/resolvers/zod';
import { Store01Icon } from '@hugeicons/core-free-icons';
import {
  type Branch,
  contractErrorMap,
  type Device,
  registerDeviceInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Dialog, DialogContent, FormAlert, SelectField, toast } from '@omnivo/ui';
import { useForm } from 'react-hook-form';

import { applyApiError } from '../lib/field-errors';

// Only the branch is the person's to choose: the id and the name come from the browser
const branchFormSchema = registerDeviceInputSchema.pick({ branchId: true });
const FIELD_NAMES = branchFormSchema.keyof().options;

// "Which branch is this device in?" (decision 12), once, after sign-in, for a workspace with more
// than one branch. Closing it any way (Esc, the backdrop, "Not now") is "Not now" (decision 40):
// the products and customers pages then offer it again with a button.
// Step 18b: the session's two answers come as props from the host, which has the session already.
// An import of local-session here would count Dexie into this lazy chunk a second time.
export function DeviceBranchDialog({
  branches,
  chooseBranch,
  chooseLater,
}: {
  branches: readonly Branch[];
  chooseBranch: (branchId: string) => Promise<Device | null>;
  chooseLater: () => void;
}) {
  const { t } = useLocale();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(branchFormSchema, { error: contractErrorMap }),
    // No branch chosen for the person: the head office is first in the list, and a shop's
    // device set up there by a quick click would pull another branch's stock
    defaultValues: { branchId: '' },
  });

  const onSubmit = handleSubmit(async ({ branchId }) => {
    try {
      const device = await chooseBranch(branchId);
      const branch = branches.find((item) => item.id === device?.branchId);
      if (branch) toast(t('devices.registered', { branch: branch.name }));
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) chooseLater();
      }}
    >
      <DialogContent
        title={t('devices.branchTitle')}
        description={t('devices.branchDescription')}
        footer={
          <>
            <Button variant="secondary" onClick={chooseLater}>
              {t('devices.later')}
            </Button>
            <Button type="submit" form="device-branch-form" disabled={isSubmitting}>
              {isSubmitting ? t('common.saving') : t('devices.useBranch')}
            </Button>
          </>
        }
      >
        <form
          id="device-branch-form"
          noValidate
          onSubmit={(event) => void onSubmit(event)}
          className="grid gap-5"
        >
          {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
          <SelectField
            label={t('devices.branch')}
            icon={Store01Icon}
            hint={t('devices.branchHint')}
            options={[
              { value: '', label: t('devices.branchPlaceholder') },
              ...branches.map((branch) => ({
                value: branch.id,
                label: `${branch.code} · ${branch.name}`,
              })),
            ]}
            {...register('branchId')}
            error={errors.branchId?.message}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
