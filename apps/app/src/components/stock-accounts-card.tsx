import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Account,
  accountTypeFits,
  contractErrorMap,
  routes,
  STOCK_ACCOUNT_USES,
  type StockAccounts,
  type StockAccountsFormValues,
  type StockAccountUse,
  updateStockAccountsInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, FormAlert, SelectField, toast } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { accountsQuery, stockAccountsQuery } from '../lib/queries';

// Settings → Inventory, step 14: where stock documents post in the books. Its own form and save
// button: the choices are saved by their own endpoint, apart from the company settings above.
const GROUPS: readonly {
  key: 'adjustments' | 'transfers' | 'revaluation';
  uses: StockAccountUse[];
}[] = [
  {
    key: 'adjustments',
    uses: ['found', 'damaged', 'expired', 'lost', 'sample', 'internal_use', 'correction'],
  },
  { key: 'transfers', uses: ['in_transit', 'transfer_shortage'] },
  { key: 'revaluation', uses: ['revaluation'] },
];

function toForm(choices: StockAccounts): StockAccountsFormValues {
  return {
    in_transit: choices.in_transit ?? '',
    found: choices.found ?? '',
    damaged: choices.damaged ?? '',
    expired: choices.expired ?? '',
    lost: choices.lost ?? '',
    sample: choices.sample ?? '',
    internal_use: choices.internal_use ?? '',
    correction: choices.correction ?? '',
    transfer_shortage: choices.transfer_shortage ?? '',
    revaluation: choices.revaluation ?? '',
  };
}

function label(account: Account | undefined): string {
  return account ? `${account.code} · ${account.name}` : '—';
}

export function StockAccountsCard({
  tenantId,
  canManage,
}: {
  tenantId: string;
  canManage: boolean;
}) {
  const choices = useQuery(stockAccountsQuery(tenantId)).data;
  const accounts = useQuery(accountsQuery(tenantId)).data;
  if (!choices || !accounts) return null;
  // key: a saved form comes back with the new choices, and starts from them again
  return (
    <StockAccountsForm
      key={JSON.stringify(choices)}
      tenantId={tenantId}
      choices={choices}
      accounts={accounts}
      canManage={canManage}
    />
  );
}

function StockAccountsForm({
  tenantId,
  choices,
  accounts,
  canManage,
}: {
  tenantId: string;
  choices: StockAccounts;
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
    resolver: zodResolver(updateStockAccountsInputSchema, { error: contractErrorMap }),
    defaultValues: toForm(choices),
  });
  const inventory = accounts.find((account) => account.purpose === 'inventory');
  const equity = accounts.find((account) => account.purpose === 'opening_balance_equity');
  const missing = STOCK_ACCOUNT_USES.some((use) => choices[use] === null);

  // What each use may point at, like the API: an active ledger of a type that fits, never the
  // inventory account. The current choice stays in the list even if it no longer fits (archived
  // since), so the select shows it instead of silently moving to the first option.
  const optionsFor = (use: StockAccountUse) => [
    { value: '', label: t('settings.stockAccountPlaceholder') },
    ...accounts
      .filter(
        (account) =>
          account.id === choices[use] ||
          (!account.isGroup &&
            account.archivedAt === null &&
            account.purpose !== 'inventory' &&
            accountTypeFits(use, account.type)),
      )
      .toSorted((a, b) => a.code.localeCompare(b.code))
      .map((account) => ({ value: account.id, label: label(account) })),
  ];

  const save = handleSubmit(async (values) => {
    try {
      await call(routes.stockAccounts.update, { body: values });
      await queryClient.invalidateQueries({ queryKey: ['stock-accounts', tenantId] });
      toast(t('settings.stockAccountsSaved'));
    } catch (error) {
      applyApiError(error, [...STOCK_ACCOUNT_USES], setError);
    }
  });

  return (
    <Card>
      <CardHeader
        title={t('settings.stockAccountsTitle')}
        subtitle={t('settings.stockAccountsSubtitle', {
          inventory: label(inventory),
          equity: label(equity),
        })}
      />
      <form noValidate onSubmit={(event) => void save(event)} className="grid gap-5 p-5">
        {missing && <FormAlert message={t('settings.stockAccountsMissing')} />}
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {GROUPS.map((group) => (
          <fieldset key={group.key} className="grid gap-4" disabled={!canManage}>
            <legend className="mb-3 text-caption font-medium text-ink-3">
              {t(`settings.stockAccountGroups.${group.key}`)}
            </legend>
            <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
              {group.uses.map((use) => (
                <SelectField
                  key={use}
                  label={t(`settings.stockAccountUses.${use}`)}
                  hint={
                    use === 'in_transit' || use === 'transfer_shortage' || use === 'revaluation'
                      ? t(`settings.stockAccountHints.${use}`)
                      : undefined
                  }
                  options={optionsFor(use)}
                  {...register(use)}
                  error={errors[use]?.message}
                />
              ))}
            </div>
          </fieldset>
        ))}
        {canManage && (
          <div className="flex justify-end">
            <Button type="submit" variant="secondary" disabled={isSubmitting || !isDirty}>
              {isSubmitting ? t('common.saving') : t('settings.stockAccountsSave')}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
