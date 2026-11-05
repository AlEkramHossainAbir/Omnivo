import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Account,
  contractErrorMap,
  type PurchaseAccounts,
  routes,
  updatePurchaseAccountsInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, FormAlert, SelectField, toast } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { accountsQuery, purchaseAccountsQuery } from '../lib/queries';

// Settings → Purchase accounts, step 17c (decision 17): where a supplier bill posts a price that
// differs from its order's, and a service line that names no account. A card of its own like the
// sales accounts of 15d: its own endpoint, its own save button.
export function PurchaseAccountsCard({
  tenantId,
  canManage,
}: {
  tenantId: string;
  canManage: boolean;
}) {
  const choices = useQuery(purchaseAccountsQuery(tenantId)).data;
  const accounts = useQuery(accountsQuery(tenantId)).data;
  if (!choices || !accounts) return null;
  // key: a saved form comes back with the new choices, and starts from them again
  return (
    <PurchaseAccountsForm
      key={`${choices.priceDifference ?? 'none'}-${choices.services ?? 'none'}`}
      tenantId={tenantId}
      choices={choices}
      accounts={accounts}
      canManage={canManage}
    />
  );
}

function PurchaseAccountsForm({
  tenantId,
  choices,
  accounts,
  canManage,
}: {
  tenantId: string;
  choices: PurchaseAccounts;
  accounts: readonly Account[];
  canManage: boolean;
}) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(updatePurchaseAccountsInputSchema, { error: contractErrorMap }),
    defaultValues: {
      priceDifference: choices.priceDifference ?? '',
      services: choices.services ?? '',
    },
  });

  // Like the API (purchase_account_invalid): an active expense account that is not a group. Both
  // sit in the profit and loss. A current choice stays in the list even if it was archived since,
  // so the select shows it instead of silently moving to "None".
  const optionsFor = (current: string | null, none: string) => [
    { value: '', label: none },
    ...accounts
      .filter(
        (account) =>
          account.id === current ||
          (account.type === 'expense' && !account.isGroup && account.archivedAt === null),
      )
      .toSorted((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
      .map((account) => ({ value: account.id, label: `${account.code} · ${account.name}` })),
  ];

  const save = handleSubmit(async (values) => {
    try {
      await call(routes.purchaseAccounts.update, { body: values });
      await queryClient.invalidateQueries({ queryKey: ['purchase-accounts', tenantId] });
      toast(t('settings.purchaseAccountsSaved'));
    } catch (error) {
      applyApiError(error, ['priceDifference', 'services'], setError);
    }
  });

  return (
    <Card>
      <CardHeader
        title={t('settings.purchaseAccountsTitle')}
        subtitle={t('settings.purchaseAccountsSubtitle')}
      />
      <form noValidate onSubmit={(event) => void save(event)} className="grid gap-5 p-5">
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {/* Read only without core.settings.manage: everyone may see where bills are booked */}
        <fieldset disabled={!canManage} className="grid gap-5">
          <SelectField
            label={t('settings.priceDifferenceAccount')}
            hint={t('settings.priceDifferenceAccountHint')}
            options={optionsFor(choices.priceDifference, t('settings.priceDifferenceAccountNone'))}
            {...register('priceDifference')}
            error={errors.priceDifference?.message}
          />
          <SelectField
            label={t('settings.servicesAccount')}
            hint={t('settings.servicesAccountHint')}
            options={optionsFor(choices.services, t('settings.servicesAccountNone'))}
            {...register('services')}
            error={errors.services?.message}
          />
        </fieldset>
        {canManage && (
          <div className="flex justify-end">
            <Button type="submit" variant="secondary" disabled={isSubmitting || !isDirty}>
              {isSubmitting ? t('common.saving') : t('settings.purchaseAccountsSave')}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
