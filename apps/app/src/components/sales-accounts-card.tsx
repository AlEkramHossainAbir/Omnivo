import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Account,
  contractErrorMap,
  routes,
  type SalesAccounts,
  updateSalesAccountsInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, FormAlert, SelectField, toast } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { accountsQuery, salesAccountsQuery } from '../lib/queries';

// Settings → Sales, step 15d: the account a credit note takes the sale back from (decision 7). A
// card of its own, like the stock accounts of step 14: its own endpoint, its own save button.
export function SalesAccountsCard({
  tenantId,
  canManage,
}: {
  tenantId: string;
  canManage: boolean;
}) {
  const choices = useQuery(salesAccountsQuery(tenantId)).data;
  const accounts = useQuery(accountsQuery(tenantId)).data;
  if (!choices || !accounts) return null;
  // key: a saved form comes back with the new choice, and starts from it again
  return (
    <SalesAccountsForm
      key={choices.returns ?? 'none'}
      tenantId={tenantId}
      choices={choices}
      accounts={accounts}
      canManage={canManage}
    />
  );
}

function SalesAccountsForm({
  tenantId,
  choices,
  accounts,
  canManage,
}: {
  tenantId: string;
  choices: SalesAccounts;
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
    resolver: zodResolver(updateSalesAccountsInputSchema, { error: contractErrorMap }),
    defaultValues: { returns: choices.returns ?? '' },
  });

  // Like the API (sales_account_invalid): an active income account that is not a group. The
  // current choice stays in the list even if it was archived since, so the select shows it instead
  // of silently moving to "None".
  const options = [
    { value: '', label: t('settings.salesReturnsAccountNone') },
    ...accounts
      .filter(
        (account) =>
          account.id === choices.returns ||
          (account.type === 'income' && !account.isGroup && account.archivedAt === null),
      )
      .toSorted((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
      .map((account) => ({ value: account.id, label: `${account.code} · ${account.name}` })),
  ];

  const save = handleSubmit(async (values) => {
    try {
      await call(routes.salesAccounts.update, { body: values });
      await queryClient.invalidateQueries({ queryKey: ['sales-accounts', tenantId] });
      toast(t('settings.salesAccountsSaved'));
    } catch (error) {
      applyApiError(error, ['returns'], setError);
    }
  });

  return (
    <Card>
      <CardHeader
        title={t('settings.salesAccountsTitle')}
        subtitle={t('settings.salesAccountsSubtitle')}
      />
      <form noValidate onSubmit={(event) => void save(event)} className="grid gap-5 p-5">
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {/* Read only without core.settings.manage: everyone may see where returns are booked */}
        <fieldset disabled={!canManage} className="grid">
          <SelectField
            label={t('settings.salesReturnsAccount')}
            hint={t('settings.salesReturnsAccountHint')}
            options={options}
            {...register('returns')}
            error={errors.returns?.message}
          />
        </fieldset>
        {canManage && (
          <div className="flex justify-end">
            <Button type="submit" variant="secondary" disabled={isSubmitting || !isDirty}>
              {isSubmitting ? t('common.saving') : t('settings.salesAccountsSave')}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
