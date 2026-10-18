import { Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type ApprovalDocument,
  type ApprovalRule,
  type ApprovalRuleFormValues,
  approvalRuleInputSchema,
  contractErrorMap,
  isApprovalDocument,
  MAX_APPROVAL_LEVELS,
  type Role,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  FormAlert,
  FormField,
  IconButton,
  MoneyInput,
  PageHeader,
  SelectField,
  toast,
} from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type Path, useFieldArray, useForm } from 'react-hook-form';

import { useTenantId } from '../components/supplier-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { rowPath } from '../lib/products';
import { approvalRulesQuery, rolesQuery } from '../lib/queries';

// Settings → Approval levels (step 17a): one card per kind of document, each its own form. A save
// replaces that kind's levels and nothing else, so two cards never overwrite each other.

// Level 1 | from amount | role | remove: one template for every row of a card
const LEVEL_ROW = 'grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.25rem]';

function fieldNames(count: number): Path<ApprovalRuleFormValues>[] {
  return [
    'levels',
    ...Array.from({ length: count }, (_, index) => [
      rowPath('levels', index, 'minAmount'),
      rowPath('levels', index, 'roleId'),
    ]).flat(),
  ];
}

function RuleCard({
  document,
  rule,
  roles,
  canManage,
}: {
  document: ApprovalDocument;
  rule: ApprovalRule;
  roles: readonly Role[];
  canManage: boolean;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const title = t(`approvalRules.documents.${document}.title`);
  const {
    register,
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(approvalRuleInputSchema, { error: contractErrorMap }),
    defaultValues: {
      levels: rule.levels.map((level) => ({ minAmount: level.minAmount, roleId: level.role.id })),
      // 0 while the workspace never saved levels for this kind (no row yet)
      version: rule.version,
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'levels' });

  const onSubmit = handleSubmit(async (body) => {
    try {
      const saved = await call(routes.approvalRules.update, { params: { document }, body });
      // The saved rule into the list at once; the card's key (its version) then starts the form
      // again from what the server kept
      queryClient.setQueryData(approvalRulesQuery(tenantId).queryKey, (before) =>
        before?.map((item) => (item.document === saved.document ? saved : item)),
      );
      toast(t('approvalRules.saved', { document: title }));
    } catch (error) {
      applyApiError(error, fieldNames(getValues('levels').length), setError);
    }
  });

  // A new level starts at the amount of the one above it: the order rule (each level from that
  // amount or more) then holds until the person types a bigger one
  const addLevel = () => {
    const last = getValues('levels').at(-1);
    append({ minAmount: last?.minAmount ?? '0', roleId: '' });
  };

  const roleOptions = [
    { value: '', label: t('approvalRules.rolePlaceholder') },
    ...roles.map((role) => ({ value: role.id, label: role.name })),
  ];
  const levelsError = errors.levels?.root?.message ?? errors.levels?.message;

  return (
    <Card>
      <CardHeader title={title} subtitle={t(`approvalRules.documents.${document}.subtitle`)} />
      <form
        noValidate
        aria-label={title}
        onSubmit={(event) => void onSubmit(event)}
        className="grid grid-cols-1 gap-4 p-5"
      >
        {/* Without the permission the levels are read, every control disabled at once */}
        <fieldset disabled={!canManage} className="grid min-w-0 grid-cols-1 gap-4">
          {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
          {fields.length === 0 ? (
            <p className="text-body-sm text-ink-2">{t('approvalRules.none')}</p>
          ) : (
            <ol className="grid grid-cols-1 gap-3">
              {fields.map((field, index) => {
                const number = index + 1;
                const rowErrors = errors.levels?.[index];
                return (
                  <li
                    key={field.id}
                    role="group"
                    aria-label={t('approvalRules.level', { number })}
                    className="grid grid-cols-1 gap-3 rounded-control border border-line p-4"
                  >
                    <span className="text-label font-medium text-ink-2">
                      {t('approvalRules.level', { number })}
                    </span>
                    <div className={LEVEL_ROW}>
                      <FormField
                        control={control}
                        name={rowPath('levels', index, 'minAmount')}
                        label={t('approvalRules.from')}
                        hint={t('approvalRules.fromHint')}
                      >
                        {/* Whole taka: a level starts at ৳50,000, never at ৳50,000.50 */}
                        {(input) => <MoneyInput {...input} scale={0} />}
                      </FormField>
                      <SelectField
                        id={rowPath('levels', index, 'roleId')}
                        label={t('approvalRules.role')}
                        options={roleOptions}
                        {...register(rowPath('levels', index, 'roleId'))}
                        error={rowErrors?.roleId?.message}
                      />
                      {canManage && (
                        // Level with the boxes, below their labels
                        <IconButton
                          icon={Delete02Icon}
                          label={t('approvalRules.remove', { number })}
                          className="justify-self-end sm:mt-[26px] sm:self-start"
                          onClick={() => {
                            remove(index);
                          }}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {levelsError && <p className="text-label text-crit">{errorText(levelsError)}</p>}
          <div className="grid gap-1 text-label text-ink-3">
            <p>{t('approvalRules.rules')}</p>
            <p>{t('approvalRules.applies')}</p>
          </div>
          {canManage && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={fields.length >= MAX_APPROVAL_LEVELS}
                onClick={addLevel}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
                {t('approvalRules.add')}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? t('common.saving') : t('approvalRules.save')}
              </Button>
            </div>
          )}
          {canManage && fields.length >= MAX_APPROVAL_LEVELS && (
            <p className="text-label text-ink-3">
              {t('approvalRules.tooMany', { max: MAX_APPROVAL_LEVELS })}
            </p>
          )}
        </fieldset>
      </form>
    </Card>
  );
}

export function ApprovalRulesPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const canManage = useCan()('core.settings.manage');
  const { data: rules, isError } = useQuery(approvalRulesQuery(tenantId));
  const roles = useQuery(rolesQuery(tenantId)).data;

  return (
    <div className="grid max-w-3xl grid-cols-1 gap-5">
      <PageHeader title={t('approvalRules.title')} description={t('approvalRules.description')} />
      {!canManage && <p className="text-body-sm text-ink-3">{t('approvalRules.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('approvalRules.loadFailed')}</p>}
      {rules &&
        roles &&
        rules.map((rule) => {
          // A kind a newer server knows and this app does not: no card, instead of a broken one
          const { document } = rule;
          if (!isApprovalDocument(document)) return null;
          return (
            // key with the version: after a save the form starts again from the saved levels
            <RuleCard
              key={`${document}-${String(rule.version)}`}
              document={document}
              rule={rule}
              roles={roles}
              canManage={canManage}
            />
          );
        })}
    </div>
  );
}
