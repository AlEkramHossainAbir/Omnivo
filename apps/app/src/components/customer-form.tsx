import {
  Call02Icon,
  Delete02Icon,
  Mail01Icon,
  PlusSignIcon,
  TruckDeliveryIcon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ADDRESS_KINDS,
  contractErrorMap,
  type Customer,
  MAX_CUSTOMER_ADDRESSES,
  MAX_PAYMENT_TERMS_DAYS,
  routes,
  type SyncCommandError,
  type SyncCustomerGroup,
  type SyncPriceList,
  updateCustomerInputSchema,
} from '@omnivo/contracts';
import { LANGUAGES, useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  cn,
  FormAlert,
  FormField,
  IconButton,
  MoneyInput,
  PageHeader,
  Pill,
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { saveCustomer } from '@omnivo/sync';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect } from 'react';
import { type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import { applyApiError, applyCommandError } from '../lib/field-errors';
import { call } from '../lib/api';
import { requestSync, type SaveMode, useLocalDb } from '../lib/local-data';
import { rowPath } from '../lib/products';
import { customerQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useOnline } from '../lib/use-online';
import { DocumentNotice } from './sales-parts';

// The customer form: a chunk of its own (loaded by routes/customer.tsx), like the product form.
// The schema is the contract's own, so the form refuses what the API refuses, in the same words.

type FormValues = z.input<typeof updateCustomerInputSchema>;
type AddressValues = FormValues['addresses'][number];

// A customer as the form holds it: '' for every empty box. A new customer is due on receipt and
// has no limit until someone sets them.
function valuesOf(customer: Customer | null): FormValues {
  return {
    code: customer?.code ?? '',
    name: customer?.name ?? '',
    groupId: customer?.groupId ?? '',
    contactPerson: customer?.contactPerson ?? '',
    phone: customer?.phone ?? '',
    email: customer?.email ?? '',
    // Step 16: English until someone picks Bangla (decision 4)
    documentLanguage: customer?.documentLanguage ?? 'en',
    bin: customer?.bin ?? '',
    paymentTermsDays: customer?.paymentTermsDays ?? 0,
    // "0.0000" stays: a limit of nothing is cash only, not "no limit"
    creditLimit: customer?.creditLimit ?? '',
    priceListId: customer?.priceListId ?? '',
    notes: customer?.notes ?? '',
    addresses:
      customer?.addresses.map((address) => ({
        id: address.id,
        // An unknown kind from a newer server reads as shipping, the harmless one
        kind: ADDRESS_KINDS.find((kind) => kind === address.kind) ?? 'shipping',
        label: address.label ?? '',
        address: address.address,
        phone: address.phone ?? '',
      })) ?? [],
    // A new customer has no version; 1 passes the schema, and the create route never reads it.
    // Step 18b: nor does one made on this device (version 0, overlay.ts), whose save goes to the
    // outbox. With its 0 the schema refused every save, and showed no box to fix.
    version: customer === null || customer.version === 0 ? 1 : customer.version,
  };
}

// Every field the server may name in an error, so it lands under the right box
function fieldNames(addressCount: number): Path<FormValues>[] {
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
    'creditLimit',
    'priceListId',
    'notes',
    'addresses',
    ...Array.from({ length: addressCount }, (_, index) => [
      rowPath('addresses', index, 'kind'),
      rowPath('addresses', index, 'label'),
      rowPath('addresses', index, 'address'),
      rowPath('addresses', index, 'phone'),
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

// A path of a refused change names an address by its id (decision 22): the form's errors go by
// the address's place in the list
function addressPlaces(customer: Customer | null): (path: string) => string {
  const ids = customer?.addresses.map((address) => address.id) ?? [];
  return (path) =>
    path.replace(/^addresses\.([0-9a-f-]{36})\./, (whole, id: string) => {
      const index = ids.indexOf(id);
      return index === -1 ? whole : `addresses.${String(index)}.`;
    });
}

export function CustomerForm({
  customer,
  groups,
  priceLists,
  canManage,
  mode,
  failed,
}: {
  // Step 18b: in device mode, the server's customer with the waiting changes on it
  customer: Customer | null;
  // The server's or the device's (step 18b): the form needs only their ids and names
  groups: SyncCustomerGroup[];
  // All of them, archived ones too: the customer's own list stays in the select if it was
  // archived since (like an archived unit on a product), and the server keeps it on save
  priceLists: SyncPriceList[];
  canManage: boolean;
  // Step 18b (decision 2): 'api' saves through the API as before; 'device' into the outbox
  mode: SaveMode;
  // The error of the customer's refused command, shown under its boxes until the next save
  failed: SyncCommandError | null;
}) {
  const { t, errorText } = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const online = useOnline();
  const db = useLocalDb();
  const onDevice = mode === 'device';
  const {
    register,
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateCustomerInputSchema, { error: contractErrorMap }),
    defaultValues: valuesOf(customer),
  });
  const addressArray = useFieldArray({ control, name: 'addresses' });

  // Once, when the form opens a refused command: its errors where the person fixes them
  useEffect(() => {
    if (failed) {
      applyCommandError(
        failed,
        fieldNames(customer?.addresses.length ?? 0),
        setError,
        addressPlaces(customer),
      );
    }
  }, [failed, customer, setError]);
  const addresses = useWatch({ control, name: 'addresses' });
  // The first shipping address is the default on a delivery (step 15b): the form says so
  const defaultShipping = addresses.findIndex((address) => address.kind === 'shipping');

  const priceListOptions = [
    { value: '', label: t('customers.fields.noPriceList') },
    ...priceLists
      .filter((list) => list.archivedAt === null || list.id === customer?.priceListId)
      .map((list) => ({ value: list.id, label: list.name })),
  ];

  // The first address is the billing one; after that, shipping addresses (one billing only)
  const newAddress = (): AddressValues => ({
    id: null,
    kind: addresses.some((address) => address.kind === 'billing') ? 'shipping' : 'billing',
    label: '',
    address: '',
    phone: '',
  });

  const onSubmit = handleSubmit(async ({ version, ...values }) => {
    if (onDevice) {
      if (!db) return;
      try {
        await saveCustomer(db, {
          base: customer,
          input: values,
          savedAt: new Date().toISOString(),
        });
      } catch {
        // IndexedDB refused the write (a full disk): the text, not a code, like the credit errors
        setError('root.server', { message: t('sync.saveFailed') });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
      requestSync();
      toast(t('sync.savedOnDevice'));
      // The list, where it shows "Not synced": the customer's page needs the server
      void navigate({ to: '/customers', replace: true });
      return;
    }
    try {
      const saved = customer
        ? await call(routes.customers.update, {
            params: { id: customer.id },
            body: { ...values, version },
          })
        : await call(routes.customers.create, { body: values });
      queryClient.setQueryData(customerQuery(tenantId, saved.id).queryKey, saved);
      await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
      toast(t(customer ? 'customers.updated' : 'customers.created', { name: saved.name }));
      // To the customer's page; replace: Back from there goes to the list, not to the form
      void navigate({
        to: '/customers/$customerId',
        params: { customerId: saved.id },
        replace: true,
      });
    } catch (error) {
      applyApiError(error, fieldNames(getValues('addresses').length), setError);
    }
  });

  const addressesError = errors.addresses?.root?.message ?? errors.addresses?.message;

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      {customer && !onDevice ? (
        <Link
          to="/customers/$customerId"
          params={{ customerId: customer.id }}
          className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          ← {customer.name}
        </Link>
      ) : (
        <Link
          to="/customers"
          className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          ← {t('customers.back')}
        </Link>
      )}
      <PageHeader
        title={
          customer ? t('customers.editTitle', { code: customer.code }) : t('customers.newTitle')
        }
        description={customer?.name}
      />
      {!canManage && <p className="text-body-sm text-ink-3">{t('customers.readOnly')}</p>}
      {canManage && onDevice && (
        <DocumentNotice tone="neutral">
          {online ? t('sync.waitingNotice') : t('sync.offlineNotice')}
        </DocumentNotice>
      )}
      <form noValidate onSubmit={(event) => void onSubmit(event)}>
        {/* Without the permission the same page reads, every control disabled at once */}
        <fieldset disabled={!canManage} className="grid min-w-0 grid-cols-1 gap-5">
          {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}

          <SectionCard title={t('customers.sections.basics')}>
            <TextField
              label={t('customers.fields.name')}
              icon={UserIcon}
              placeholder={t('customers.fields.namePlaceholder')}
              {...register('name')}
              error={errors.name?.message}
            />
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
              <TextField
                label={t('customers.fields.code')}
                hint={
                  customer
                    ? undefined
                    : // Offline the next number is not known (decision 16)
                      t(onDevice ? 'sync.codeOfflineHint' : 'customers.fields.codeHint')
                }
                optional={!customer}
                autoCapitalize="characters"
                spellCheck={false}
                {...register('code')}
                error={errors.code?.message}
              />
              <SelectField
                label={t('customers.fields.group')}
                options={[
                  { value: '', label: t('customers.fields.noGroup') },
                  ...groups.map((group) => ({ value: group.id, label: group.name })),
                ]}
                {...register('groupId')}
                error={errors.groupId?.message}
              />
              <TextField
                label={t('customers.fields.contactPerson')}
                optional
                placeholder={t('customers.fields.contactPersonPlaceholder')}
                {...register('contactPerson')}
                error={errors.contactPerson?.message}
              />
              <TextField
                label={t('customers.fields.phone')}
                optional
                type="tel"
                icon={Call02Icon}
                placeholder="01711-234567"
                {...register('phone')}
                error={errors.phone?.message}
              />
              <TextField
                label={t('customers.fields.email')}
                optional
                type="email"
                icon={Mail01Icon}
                placeholder="accounts@rahmantraders.com.bd"
                {...register('email')}
                error={errors.email?.message}
              />
              <TextField
                label={t('customers.fields.bin')}
                optional
                inputMode="numeric"
                hint={t('customers.fields.binHint')}
                placeholder="000123456-0101"
                {...register('bin')}
                error={errors.bin?.message}
              />
              {/* Step 16: each language by its own name, like the language switch (decision 32) */}
              <SelectField
                label={t('customers.fields.documentLanguage')}
                hint={t('customers.fields.documentLanguageHint')}
                options={LANGUAGES.map((language) => ({
                  value: language.code,
                  label: language.label,
                }))}
                {...register('documentLanguage')}
                error={errors.documentLanguage?.message}
              />
            </div>
            <TextAreaField
              label={t('customers.fields.notes')}
              optional
              placeholder={t('customers.fields.notesPlaceholder')}
              {...register('notes')}
              error={errors.notes?.message}
            />
          </SectionCard>

          <SectionCard
            title={t('customers.sections.terms')}
            subtitle={t('customers.sections.termsHint')}
            className="sm:grid-cols-2 sm:gap-x-4"
          >
            <TextField
              label={t('customers.fields.paymentTerms')}
              hint={t('customers.fields.paymentTermsHint')}
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_PAYMENT_TERMS_DAYS}
              suffix={t('customers.fields.days')}
              // valueAsNumber: the contract takes a number of days, not the box's text
              {...register('paymentTermsDays', { valueAsNumber: true })}
              error={errors.paymentTermsDays?.message}
            />
            <FormField
              control={control}
              name="creditLimit"
              label={t('customers.fields.creditLimit')}
              hint={t('customers.fields.creditLimitHint')}
              optional
            >
              {(field) => <MoneyInput {...field} value={field.value ?? ''} />}
            </FormField>
            <SelectField
              label={t('customers.fields.priceList')}
              options={priceListOptions}
              {...register('priceListId')}
              error={errors.priceListId?.message}
            />
          </SectionCard>

          <SectionCard
            title={t('customers.sections.addresses')}
            subtitle={t('customers.sections.addressesHint')}
          >
            {addressArray.fields.length === 0 && (
              <p className="text-body-sm text-ink-3">{t('customers.addresses.empty')}</p>
            )}
            {addressArray.fields.length > 0 && (
              <ul aria-label={t('customers.sections.addresses')} className="grid gap-3">
                {addressArray.fields.map((row, index) => {
                  const number = index + 1;
                  const rowErrors = errors.addresses?.[index];
                  return (
                    <li
                      key={row.id}
                      role="group"
                      aria-label={t('customers.addresses.number', { number })}
                      className="grid grid-cols-1 gap-4 rounded-control border border-line p-4 sm:grid-cols-2 sm:gap-x-4"
                    >
                      <div className="flex items-center justify-between gap-3 sm:col-span-2">
                        <span className="flex flex-wrap items-center gap-2 text-label font-medium text-ink-2">
                          {t('customers.addresses.number', { number })}
                          {index === defaultShipping && (
                            <Pill tone="brand" icon={TruckDeliveryIcon}>
                              {t('customers.addresses.defaultShipping')}
                            </Pill>
                          )}
                        </span>
                        <IconButton
                          icon={Delete02Icon}
                          label={t('customers.addresses.remove', { number })}
                          onClick={() => {
                            addressArray.remove(index);
                          }}
                        />
                      </div>
                      <SelectField
                        id={rowPath('addresses', index, 'kind')}
                        label={t('customers.addresses.kind')}
                        options={ADDRESS_KINDS.map((kind) => ({
                          value: kind,
                          label: t(`customers.addresses.kinds.${kind}`),
                        }))}
                        {...register(rowPath('addresses', index, 'kind'))}
                        error={rowErrors?.kind?.message}
                      />
                      <TextField
                        id={rowPath('addresses', index, 'label')}
                        label={t('customers.addresses.label')}
                        optional
                        placeholder={t('customers.addresses.labelPlaceholder')}
                        {...register(rowPath('addresses', index, 'label'))}
                        error={rowErrors?.label?.message}
                      />
                      <div className="sm:col-span-2">
                        <TextAreaField
                          id={rowPath('addresses', index, 'address')}
                          label={t('customers.addresses.address')}
                          placeholder="House 12, Road 7, Sector 4, Uttara, Dhaka 1230"
                          {...register(rowPath('addresses', index, 'address'))}
                          error={rowErrors?.address?.message}
                        />
                      </div>
                      <TextField
                        id={rowPath('addresses', index, 'phone')}
                        label={t('customers.addresses.phone')}
                        optional
                        type="tel"
                        icon={Call02Icon}
                        {...register(rowPath('addresses', index, 'phone'))}
                        error={rowErrors?.phone?.message}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            {addressesError && <p className="text-label text-crit">{errorText(addressesError)}</p>}
            <div>
              <Button
                variant="secondary"
                size="sm"
                disabled={addressArray.fields.length >= MAX_CUSTOMER_ADDRESSES}
                onClick={() => {
                  addressArray.append(newAddress());
                }}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
                {t('customers.addresses.add')}
              </Button>
            </div>
          </SectionCard>

          {canManage && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  void (customer && !onDevice
                    ? navigate({
                        to: '/customers/$customerId',
                        params: { customerId: customer.id },
                      })
                    : navigate({ to: '/customers' }))
                }
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? t('common.saving')
                  : onDevice
                    ? t('sync.saveOnDevice')
                    : customer
                      ? t('customers.save')
                      : t('customers.create')}
              </Button>
            </div>
          )}
        </fieldset>
      </form>
    </div>
  );
}
