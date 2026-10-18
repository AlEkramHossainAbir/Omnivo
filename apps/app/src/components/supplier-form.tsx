import {
  BankIcon,
  Call02Icon,
  Delete02Icon,
  Factory01Icon,
  Mail01Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  MAX_PAYMENT_TERMS_DAYS,
  MAX_SUPPLIER_BANK_ACCOUNTS,
  routes,
  type Supplier,
  type SupplierGroup,
  updateSupplierInputSchema,
} from '@omnivo/contracts';
import { LANGUAGES, useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  cn,
  FormAlert,
  IconButton,
  PageHeader,
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { type Path, useFieldArray, useForm } from 'react-hook-form';
import type { z } from 'zod';

import { applyApiError } from '../lib/field-errors';
import { call } from '../lib/api';
import { rowPath } from '../lib/products';
import { supplierQuery } from '../lib/queries';
import { usePartyRefresh, useTenantId } from './supplier-parts';

// The supplier form: a chunk of its own (loaded by routes/supplier-edit.tsx), like the customer
// form. The schema is the contract's own, so the form refuses what the API refuses, in the same
// words.

type FormValues = z.input<typeof updateSupplierInputSchema>;
type BankAccountValues = FormValues['bankAccounts'][number];

// A supplier as the form holds it: '' for every empty box. A new supplier is paid on receipt
// until someone sets the terms.
function valuesOf(supplier: Supplier | null): FormValues {
  return {
    code: supplier?.code ?? '',
    name: supplier?.name ?? '',
    groupId: supplier?.groupId ?? '',
    contactPerson: supplier?.contactPerson ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    documentLanguage: supplier?.documentLanguage ?? 'en',
    bin: supplier?.bin ?? '',
    paymentTermsDays: supplier?.paymentTermsDays ?? 0,
    address: supplier?.address ?? '',
    // The id goes back with each account, so the server changes that row instead of making a new
    // one: 17c's payments will point at the account they were sent to
    bankAccounts:
      supplier?.bankAccounts.map((account) => ({
        id: account.id,
        bankName: account.bankName,
        branchName: account.branchName ?? '',
        accountName: account.accountName,
        accountNumber: account.accountNumber,
        routingNumber: account.routingNumber ?? '',
      })) ?? [],
    notes: supplier?.notes ?? '',
    // A new supplier has no version; 1 passes the schema, and the create route never reads it
    version: supplier?.version ?? 1,
  };
}

// A new account's boxes, all empty. id null: the server makes the row.
const newBankAccount = (): BankAccountValues => ({
  id: null,
  bankName: '',
  branchName: '',
  accountName: '',
  accountNumber: '',
  routingNumber: '',
});

// Every field the server may name in an error, so it lands under the right box
function fieldNames(accountCount: number): Path<FormValues>[] {
  return [
    'code',
    'name',
    'groupId',
    'contactPerson',
    'phone',
    'email',
    'documentLanguage',
    'bin',
    'paymentTermsDays',
    'address',
    'notes',
    'bankAccounts',
    ...Array.from({ length: accountCount }, (_, index) => [
      rowPath('bankAccounts', index, 'bankName'),
      rowPath('bankAccounts', index, 'branchName'),
      rowPath('bankAccounts', index, 'accountName'),
      rowPath('bankAccounts', index, 'accountNumber'),
      rowPath('bankAccounts', index, 'routingNumber'),
    ]).flat(),
  ];
}

function SectionCard({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <div className={cn('grid grid-cols-1 gap-5 p-5', className)}>{children}</div>
    </Card>
  );
}

export function SupplierForm({
  supplier,
  groups,
  canManage,
}: {
  supplier: Supplier | null;
  groups: SupplierGroup[];
  canManage: boolean;
}) {
  const { t, errorText } = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  const refresh = usePartyRefresh();
  const {
    register,
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateSupplierInputSchema, { error: contractErrorMap }),
    defaultValues: valuesOf(supplier),
  });
  const accountArray = useFieldArray({ control, name: 'bankAccounts' });

  const onSubmit = handleSubmit(async ({ version, ...values }) => {
    try {
      const saved = supplier
        ? await call(routes.suppliers.update, {
            params: { id: supplier.id },
            body: { ...values, version },
          })
        : await call(routes.suppliers.create, { body: values });
      queryClient.setQueryData(supplierQuery(tenantId, saved.id).queryKey, saved);
      await refresh();
      toast(t(supplier ? 'suppliers.updated' : 'suppliers.created', { name: saved.name }));
      // To the supplier's page; replace: Back from there goes to the list, not to the form
      void navigate({
        to: '/suppliers/$supplierId',
        params: { supplierId: saved.id },
        replace: true,
      });
    } catch (error) {
      applyApiError(error, fieldNames(getValues('bankAccounts').length), setError);
    }
  });

  const accountsError = errors.bankAccounts?.root?.message ?? errors.bankAccounts?.message;

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      {supplier ? (
        <Link
          to="/suppliers/$supplierId"
          params={{ supplierId: supplier.id }}
          className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          ← {supplier.name}
        </Link>
      ) : (
        <Link
          to="/suppliers"
          className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          ← {t('suppliers.back')}
        </Link>
      )}
      <PageHeader
        title={
          supplier ? t('suppliers.editTitle', { code: supplier.code }) : t('suppliers.newTitle')
        }
        description={supplier?.name}
      />
      {!canManage && <p className="text-body-sm text-ink-3">{t('suppliers.readOnly')}</p>}
      <form noValidate onSubmit={(event) => void onSubmit(event)}>
        {/* Without the permission the same page reads, every control disabled at once */}
        <fieldset disabled={!canManage} className="grid min-w-0 grid-cols-1 gap-5">
          {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}

          <SectionCard title={t('suppliers.sections.basics')}>
            <TextField
              label={t('suppliers.fields.name')}
              icon={Factory01Icon}
              placeholder={t('suppliers.fields.namePlaceholder')}
              {...register('name')}
              error={errors.name?.message}
            />
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
              <TextField
                label={t('suppliers.fields.code')}
                hint={supplier ? undefined : t('suppliers.fields.codeHint')}
                optional={!supplier}
                autoCapitalize="characters"
                spellCheck={false}
                {...register('code')}
                error={errors.code?.message}
              />
              <SelectField
                label={t('suppliers.fields.group')}
                options={[
                  { value: '', label: t('suppliers.fields.noGroup') },
                  ...groups.map((group) => ({ value: group.id, label: group.name })),
                ]}
                {...register('groupId')}
                error={errors.groupId?.message}
              />
              <TextField
                label={t('suppliers.fields.contactPerson')}
                optional
                placeholder={t('suppliers.fields.contactPersonPlaceholder')}
                {...register('contactPerson')}
                error={errors.contactPerson?.message}
              />
              <TextField
                label={t('suppliers.fields.phone')}
                optional
                type="tel"
                icon={Call02Icon}
                placeholder="01819-456789"
                {...register('phone')}
                error={errors.phone?.message}
              />
              <TextField
                label={t('suppliers.fields.email')}
                optional
                type="email"
                icon={Mail01Icon}
                placeholder="sales@meghnaspinning.com.bd"
                {...register('email')}
                error={errors.email?.message}
              />
              <TextField
                label={t('suppliers.fields.bin')}
                optional
                inputMode="numeric"
                hint={t('suppliers.fields.binHint')}
                placeholder="000456789-0202"
                {...register('bin')}
                error={errors.bin?.message}
              />
              <SelectField
                label={t('suppliers.fields.documentLanguage')}
                hint={t('suppliers.fields.documentLanguageHint')}
                options={LANGUAGES.map((language) => ({
                  value: language.code,
                  label: language.label,
                }))}
                {...register('documentLanguage')}
                error={errors.documentLanguage?.message}
              />
            </div>
            {/* One address, the party's billing address (decision 31): the hint says that a
                customer who is also this supplier shares it */}
            <TextAreaField
              label={t('suppliers.fields.address')}
              optional
              hint={t('suppliers.fields.addressHint')}
              placeholder={t('suppliers.fields.addressPlaceholder')}
              {...register('address')}
              error={errors.address?.message}
            />
            <TextAreaField
              label={t('suppliers.fields.notes')}
              optional
              placeholder={t('suppliers.fields.notesPlaceholder')}
              {...register('notes')}
              error={errors.notes?.message}
            />
          </SectionCard>

          <SectionCard
            title={t('suppliers.sections.terms')}
            subtitle={t('suppliers.sections.termsHint')}
            className="sm:grid-cols-2 sm:gap-x-4"
          >
            <TextField
              label={t('suppliers.fields.paymentTerms')}
              hint={t('suppliers.fields.paymentTermsHint')}
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_PAYMENT_TERMS_DAYS}
              suffix={t('suppliers.fields.days')}
              // valueAsNumber: the contract takes a number of days, not the box's text
              {...register('paymentTermsDays', { valueAsNumber: true })}
              error={errors.paymentTermsDays?.message}
            />
          </SectionCard>

          <SectionCard
            title={t('suppliers.sections.bankAccounts')}
            subtitle={t('suppliers.sections.bankAccountsHint', {
              max: MAX_SUPPLIER_BANK_ACCOUNTS,
            })}
          >
            {accountArray.fields.length === 0 && (
              <p className="text-body-sm text-ink-3">{t('suppliers.bankAccounts.empty')}</p>
            )}
            {accountArray.fields.length > 0 && (
              <ul aria-label={t('suppliers.sections.bankAccounts')} className="grid gap-3">
                {accountArray.fields.map((row, index) => {
                  const number = index + 1;
                  const rowErrors = errors.bankAccounts?.[index];
                  return (
                    <li
                      key={row.id}
                      role="group"
                      aria-label={t('suppliers.bankAccounts.number', { number })}
                      className="grid grid-cols-1 gap-4 rounded-control border border-line p-4 sm:grid-cols-2 sm:gap-x-4"
                    >
                      <div className="flex items-center justify-between gap-3 sm:col-span-2">
                        <span className="text-label font-medium text-ink-2">
                          {t('suppliers.bankAccounts.number', { number })}
                        </span>
                        <IconButton
                          icon={Delete02Icon}
                          label={t('suppliers.bankAccounts.remove', { number })}
                          onClick={() => {
                            accountArray.remove(index);
                          }}
                        />
                      </div>
                      <TextField
                        id={rowPath('bankAccounts', index, 'bankName')}
                        label={t('suppliers.bankAccounts.bankName')}
                        icon={BankIcon}
                        placeholder={t('suppliers.bankAccounts.bankNamePlaceholder')}
                        {...register(rowPath('bankAccounts', index, 'bankName'))}
                        error={rowErrors?.bankName?.message}
                      />
                      <TextField
                        id={rowPath('bankAccounts', index, 'branchName')}
                        label={t('suppliers.bankAccounts.branchName')}
                        optional
                        placeholder={t('suppliers.bankAccounts.branchNamePlaceholder')}
                        {...register(rowPath('bankAccounts', index, 'branchName'))}
                        error={rowErrors?.branchName?.message}
                      />
                      <div className="sm:col-span-2">
                        <TextField
                          id={rowPath('bankAccounts', index, 'accountName')}
                          label={t('suppliers.bankAccounts.accountName')}
                          placeholder={t('suppliers.bankAccounts.accountNamePlaceholder')}
                          {...register(rowPath('bankAccounts', index, 'accountName'))}
                          error={rowErrors?.accountName?.message}
                        />
                      </div>
                      {/* inputMode: the phone's number pad. Spaces and dashes typed from a cheque
                          leaf are taken out by the contract, so they are allowed here. */}
                      <TextField
                        id={rowPath('bankAccounts', index, 'accountNumber')}
                        label={t('suppliers.bankAccounts.accountNumber')}
                        hint={t('suppliers.bankAccounts.accountNumberHint')}
                        inputMode="numeric"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="1051100012345"
                        {...register(rowPath('bankAccounts', index, 'accountNumber'))}
                        error={rowErrors?.accountNumber?.message}
                      />
                      <TextField
                        id={rowPath('bankAccounts', index, 'routingNumber')}
                        label={t('suppliers.bankAccounts.routingNumber')}
                        hint={t('suppliers.bankAccounts.routingNumberHint')}
                        optional
                        inputMode="numeric"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="090264857"
                        {...register(rowPath('bankAccounts', index, 'routingNumber'))}
                        error={rowErrors?.routingNumber?.message}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            {accountsError && <p className="text-label text-crit">{errorText(accountsError)}</p>}
            <div>
              <Button
                variant="secondary"
                size="sm"
                disabled={accountArray.fields.length >= MAX_SUPPLIER_BANK_ACCOUNTS}
                onClick={() => {
                  accountArray.append(newBankAccount());
                }}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
                {t('suppliers.bankAccounts.add')}
              </Button>
            </div>
          </SectionCard>

          {canManage && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  void (supplier
                    ? navigate({
                        to: '/suppliers/$supplierId',
                        params: { supplierId: supplier.id },
                      })
                    : navigate({ to: '/suppliers' }))
                }
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? t('common.saving')
                  : supplier
                    ? t('suppliers.save')
                    : t('suppliers.create')}
              </Button>
            </div>
          )}
        </fieldset>
      </form>
    </div>
  );
}
