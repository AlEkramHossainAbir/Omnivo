import {
  Alert02Icon,
  Archive02Icon,
  Calendar03Icon,
  Delete02Icon,
  GridViewIcon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type CustomFieldDefinition,
  customFieldsInputSchema,
  isCustomFieldType,
  MAX_PRODUCT_OPTIONS,
  type Product,
  type ProductCategory,
  productFieldsSchema,
  productRules,
  PRODUCT_TYPES,
  routes,
  standardFactor,
  type TaxRate,
  TRACKING_MODES,
  type TrackingMode,
  type Unit,
  versionSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  cn,
  FormAlert,
  FormField,
  IconButton,
  Input,
  MoneyInput,
  PageHeader,
  Pill,
  SegmentedControl,
  Select,
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useMemo, useState } from 'react';
import {
  type Control,
  Controller,
  type Path,
  useFieldArray,
  useForm,
  useWatch,
} from 'react-hook-form';
import type { z } from 'zod';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import {
  categoryOptions,
  emptyVariant,
  plainFactor,
  rowPath,
  splitValues,
  syncVariants,
} from '../lib/products';
import { productQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { taxRateOptions, useRateText } from '../lib/tax-rates';
import { LineError } from './journal-parts';

// Loaded the first time a date custom field shows (date-input.tsx says why)
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

// The product form: a chunk of its own (loaded by routes/product.tsx). The schema is the
// contract's own fields and rules, with the workspace's custom fields put in — so the form refuses
// exactly what the API refuses, in the same words, before anything is sent.
function formSchema(fields: readonly CustomFieldDefinition[]) {
  return productFieldsSchema
    .extend({ customFields: customFieldsInputSchema(fields), version: versionSchema })
    .superRefine(productRules);
}

type FormValues = z.input<ReturnType<typeof formSchema>>;

// The two kinds of form: a simple product (one version) or one with options
const KINDS = ['simple', 'variants'] as const;
type Kind = (typeof KINDS)[number];

// A product as the form holds it: '' for every empty box, the active custom fields only
function valuesOf(
  product: Product | null,
  fields: readonly CustomFieldDefinition[],
  defaults: { baseUnitId: string; tracking: TrackingMode; hasExpiry: boolean },
): FormValues {
  const customFields: Record<string, string | boolean> = {};
  for (const field of fields) {
    const saved = product?.customFields[field.key];
    customFields[field.key] =
      field.type === 'boolean' ? saved === true : typeof saved === 'string' ? saved : '';
  }
  if (!product) {
    return {
      code: '',
      name: '',
      type: 'goods',
      categoryId: '',
      description: '',
      baseUnitId: defaults.baseUnitId,
      salesUnitId: '',
      purchaseUnitId: '',
      tracking: defaults.tracking,
      hasExpiry: defaults.hasExpiry,
      // '' = the workspace's default rate, which follows the default when it changes
      taxRateId: '',
      options: [],
      variants: [emptyVariant()],
      units: [],
      customFields,
      version: 1,
    };
  }
  return {
    code: product.code,
    name: product.name,
    type: product.type === 'service' ? 'service' : 'goods',
    categoryId: product.categoryId ?? '',
    description: product.description ?? '',
    baseUnitId: product.baseUnitId,
    salesUnitId: product.salesUnitId ?? '',
    purchaseUnitId: product.purchaseUnitId ?? '',
    tracking: TRACKING_MODES.find((mode) => mode === product.tracking) ?? 'none',
    hasExpiry: product.hasExpiry,
    taxRateId: product.taxRateId ?? '',
    options: product.options,
    variants: product.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      optionValues: variant.optionValues,
      barcode: variant.barcode ?? '',
      salePrice: variant.salePrice ?? '',
      archived: variant.archivedAt !== null,
    })),
    // "12.000000" from the database reads "12" in the box
    units: product.units.map((pack) => ({
      unitId: pack.unitId,
      factor: plainFactor(pack.factor),
      barcode: pack.barcode ?? '',
    })),
    customFields,
    version: product.version,
  };
}

// Every field the server may name in an error, so it lands under the right box
function fieldNames(
  values: FormValues,
  fields: readonly CustomFieldDefinition[],
): Path<FormValues>[] {
  const names: Path<FormValues>[] = [
    'code',
    'name',
    'type',
    'categoryId',
    'description',
    'baseUnitId',
    'salesUnitId',
    'purchaseUnitId',
    'tracking',
    'hasExpiry',
    'taxRateId',
    'variants',
  ];
  values.variants.forEach((_, index) => {
    names.push(
      rowPath('variants', index, 'sku'),
      rowPath('variants', index, 'barcode'),
      rowPath('variants', index, 'salePrice'),
    );
  });
  values.units.forEach((_, index) => {
    names.push(
      rowPath('units', index, 'unitId'),
      rowPath('units', index, 'factor'),
      rowPath('units', index, 'barcode'),
    );
  });
  for (const field of fields) names.push(`customFields.${field.key}`);
  return names;
}

// An option's values as one comma-separated box. Its own text while typing ("S, M," keeps the
// comma); the list goes to the form when the box is left, cleaned like the API counts values.
function ValuesInput({
  id,
  value,
  onChange,
  invalid,
}: {
  id: string;
  value: readonly string[];
  onChange: (values: string[]) => void;
  invalid: boolean;
}) {
  const { t } = useLocale();
  const [text, setText] = useState(value.join(', '));
  return (
    <Input
      id={id}
      value={text}
      invalid={invalid}
      placeholder={t('products.options.valuesPlaceholder')}
      onChange={(event) => {
        setText(event.target.value);
      }}
      onBlur={() => {
        const values = splitValues(text);
        setText(values.join(', '));
        onChange(values);
      }}
    />
  );
}

function SectionCard({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <div className={cn('grid grid-cols-1 gap-5 p-5', className)}>{children}</div>
    </Card>
  );
}

function CustomFieldInput({
  control,
  field,
}: {
  control: Control<FormValues, unknown, z.output<ReturnType<typeof formSchema>>>;
  field: CustomFieldDefinition;
}) {
  const { t } = useLocale();
  const name: Path<FormValues> = `customFields.${field.key}`;
  const optional = !field.required;
  if (!isCustomFieldType(field.type)) return null;
  if (field.type === 'boolean') {
    return (
      <Controller
        control={control}
        name={name}
        render={({ field: box }) => (
          <Checkbox
            id={name}
            label={field.label}
            checked={box.value === true}
            onCheckedChange={(checked) => {
              box.onChange(checked === true);
            }}
          />
        )}
      />
    );
  }
  if (field.type === 'date') {
    return (
      <FormField control={control} name={name} label={field.label} optional={optional}>
        {(box) => (
          // The same box, empty and disabled, for the moment the chunk loads
          <Suspense fallback={<Input id={box.id} icon={Calendar03Icon} disabled />}>
            <DatePicker
              {...box}
              value={typeof box.value === 'string' ? box.value : ''}
              onChange={box.onChange}
            />
          </Suspense>
        )}
      </FormField>
    );
  }
  return (
    <Controller
      control={control}
      name={name}
      render={({ field: box, fieldState }) => {
        const value = typeof box.value === 'string' ? box.value : '';
        return field.type === 'select' ? (
          <SelectField
            id={name}
            label={field.label}
            optional={optional}
            options={[
              { value: '', label: t('products.choose') },
              // A choice removed from the field after this product saved it stays visible
              ...[
                ...field.options,
                ...(value !== '' && !field.options.includes(value) ? [value] : []),
              ].map((option) => ({ value: option, label: option })),
            ]}
            name={box.name}
            value={value}
            onChange={box.onChange}
            onBlur={box.onBlur}
            ref={box.ref}
            error={fieldState.error?.message}
          />
        ) : (
          <TextField
            id={name}
            label={field.label}
            optional={optional}
            inputMode={field.type === 'number' ? 'decimal' : undefined}
            name={box.name}
            value={value}
            onChange={box.onChange}
            onBlur={box.onBlur}
            ref={box.ref}
            error={fieldState.error?.message}
          />
        );
      }}
    />
  );
}

export function ProductForm({
  product,
  units,
  categories,
  fields,
  defaults,
  taxRates,
  pricesIncludeVat,
  canManage,
}: {
  product: Product | null;
  units: Unit[];
  categories: ProductCategory[];
  // Archived ones too: a product keeps its own rate if it was archived since
  taxRates: TaxRate[];
  // Settings → Sales: the price boxes say whether they hold the VAT
  pricesIncludeVat: boolean;
  // The workspace's active custom fields for products
  fields: CustomFieldDefinition[];
  defaults: { tracking: TrackingMode; hasExpiry: boolean };
  canManage: boolean;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const [confirming, setConfirming] = useState(false);
  const schema = useMemo(() => formSchema(fields), [fields]);
  const pcs = units.find((unit) => unit.code === 'pcs' && unit.archivedAt === null);
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(schema, { error: contractErrorMap }),
    defaultValues: valuesOf(product, fields, { ...defaults, baseUnitId: pcs?.id ?? '' }),
  });
  const optionArray = useFieldArray({ control, name: 'options' });
  const variantArray = useFieldArray({ control, name: 'variants' });
  const packArray = useFieldArray({ control, name: 'units' });
  const [kind, setKind] = useState<Kind>(
    product && product.options.length > 0 ? 'variants' : 'simple',
  );
  const baseUnitId = useWatch({ control, name: 'baseUnitId' });
  const packs = useWatch({ control, name: 'units' });
  const type = useWatch({ control, name: 'type' });
  const tracking = useWatch({ control, name: 'tracking' });
  const options = useWatch({ control, name: 'options' });

  const unitById = useMemo(() => new Map(units.map((unit) => [unit.id, unit])), [units]);
  const base = unitById.get(baseUnitId);
  // Active units, plus the ones this product already uses (an archived unit stays on it)
  const used = new Set([product?.baseUnitId, ...(product?.units.map((pack) => pack.unitId) ?? [])]);
  const unitOptions = units
    .filter((unit) => unit.archivedAt === null || used.has(unit.id))
    .map((unit) => ({ value: unit.id, label: `${unit.code} · ${unit.name}` }));
  const defaultUnitOptions = [
    { value: '', label: base ? `${base.code} · ${base.name}` : '' },
    ...packs.flatMap((pack) => {
      const unit = unitById.get(pack.unitId);
      return unit ? [{ value: unit.id, label: `${unit.code} · ${unit.name}` }] : [];
    }),
  ];

  // A standard unit's size is not the person's to choose (a dozen is 12): filled in and fixed
  const standardOf = (unitId: string, baseId: string) => {
    const unit = unitById.get(unitId);
    const baseUnit = unitById.get(baseId);
    return unit && baseUnit ? standardFactor(unit, baseUnit) : null;
  };
  const refillFactors = (baseId: string) => {
    getValues('units').forEach((pack, index) => {
      const standard = standardOf(pack.unitId, baseId);
      if (standard !== null) setValue(rowPath('units', index, 'factor'), plainFactor(standard));
    });
  };

  const refresh = (saved?: Product) => {
    if (saved) queryClient.setQueryData(productQuery(tenantId, saved.id).queryKey, saved);
    return queryClient.invalidateQueries({ queryKey: ['products', tenantId, 'list'] });
  };

  const onSubmit = handleSubmit(async ({ version, ...values }) => {
    try {
      const saved = product
        ? await call(routes.products.update, {
            params: { id: product.id },
            body: { ...values, version },
          })
        : await call(routes.products.create, { body: values });
      await refresh(saved);
      toast(t(product ? 'products.updated' : 'products.created', { name: saved.name }));
      if (!product) {
        void navigate({
          to: '/products/$productId',
          params: { productId: saved.id },
          replace: true,
        });
      }
    } catch (error) {
      applyApiError(error, fieldNames(getValues(), fields), setError);
    }
  });

  const toggle = useMutation({
    mutationFn: (target: Product) =>
      call(target.archivedAt === null ? routes.products.archive : routes.products.restore, {
        params: { id: target.id },
        body: { version: target.version },
      }),
    onSuccess: async (saved) => {
      await refresh(saved);
      toast(
        t(saved.archivedAt === null ? 'products.restoredToast' : 'products.archivedToast', {
          name: saved.name,
        }),
      );
    },
  });
  const remove = useMutation({
    mutationFn: (target: Product) =>
      call(routes.products.remove, {
        params: { id: target.id },
        query: { version: target.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('products.deleted', { name: product?.name ?? '' }));
      void navigate({ to: '/products' });
    },
  });

  const switchKind = (next: Kind) => {
    if (next === kind) return;
    if (next === 'variants') {
      // The one variant stays (its id carries over to the first combination when created)
      optionArray.replace([{ name: '', values: [] }]);
    } else {
      const [only] = getValues('variants');
      optionArray.replace([]);
      variantArray.replace([{ ...(only ?? emptyVariant()), optionValues: [] }]);
    }
    setKind(next);
  };

  const createVariants = () => {
    const current = getValues('options');
    variantArray.replace(
      syncVariants(
        current.map((option) => ({ values: option.values })),
        getValues('variants'),
      ),
    );
  };

  const failure =
    errors.root?.server?.message ??
    (toggle.error instanceof ApiRequestError ? toggle.error.code : undefined) ??
    (remove.error instanceof ApiRequestError ? remove.error.code : undefined);
  const variantsError = errors.variants?.root?.message ?? errors.variants?.message;
  const unitWord = base?.code ?? '';
  const { errorText } = useLocale();
  const rateText = useRateText();
  const defaultRate = taxRates.find((rate) => rate.isDefault);
  const priceHint = pricesIncludeVat
    ? t('products.fields.priceWithVat')
    : t('products.fields.priceWithoutVat');

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <Link
        to="/products"
        className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
      >
        ← {t('products.back')}
      </Link>
      <PageHeader
        title={product ? t('products.editTitle', { code: product.code }) : t('products.newTitle')}
        description={product?.name}
      />
      {product?.archivedAt && (
        <p className="flex items-center gap-2 text-body-sm text-ink-2">
          <Pill tone="neutral" icon={Archive02Icon}>
            {t('products.statuses.archived')}
          </Pill>
          {t('products.archivedNotice')}
        </p>
      )}
      <form id="product-form" noValidate onSubmit={(event) => void onSubmit(event)}>
        {/* Without the permission the same page reads, every control disabled at once */}
        <fieldset disabled={!canManage} className="grid min-w-0 grid-cols-1 gap-5">
          {failure && <FormAlert message={failure} />}

          <SectionCard title={t('products.sections.basics')}>
            <TextField
              label={t('products.fields.name')}
              placeholder={t('products.fields.namePlaceholder')}
              {...register('name')}
              error={errors.name?.message}
            />
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
              <TextField
                label={t('products.fields.code')}
                hint={product ? undefined : t('products.fields.codeHint')}
                optional={!product}
                spellCheck={false}
                {...register('code')}
                error={errors.code?.message}
              />
              <SelectField
                label={t('products.fields.type')}
                options={PRODUCT_TYPES.map((value) => ({
                  value,
                  label: t(`products.types.${value}`),
                }))}
                {...register('type', {
                  onChange: () => {
                    // A service is never stocked: nothing to track
                    if (getValues('type') === 'service') {
                      setValue('tracking', 'none');
                      setValue('hasExpiry', false);
                    }
                  },
                })}
                error={errors.type?.message}
              />
            </div>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
              <SelectField
                label={t('products.fields.category')}
                options={[
                  { value: '', label: t('products.fields.noCategory') },
                  ...categoryOptions(categories),
                ]}
                {...register('categoryId')}
                error={errors.categoryId?.message}
              />
              {/* Step 15a. The first option follows the workspace default: changing the default
                  later moves every product that kept it, without editing them one by one. */}
              <SelectField
                label={t('products.fields.taxRate')}
                hint={t('products.fields.taxRateHint')}
                options={[
                  {
                    value: '',
                    label: t('products.fields.defaultTaxRate', {
                      name: defaultRate
                        ? `${defaultRate.name} · ${rateText(defaultRate.rate)}`
                        : '—',
                    }),
                  },
                  ...taxRateOptions(taxRates, rateText, product?.taxRateId ?? null),
                ]}
                {...register('taxRateId')}
                error={errors.taxRateId?.message}
              />
            </div>
            <TextAreaField
              label={t('products.fields.description')}
              optional
              {...register('description')}
              error={errors.description?.message}
            />
          </SectionCard>

          <SectionCard
            title={t('products.sections.units')}
            subtitle={t('products.sections.unitsHint')}
          >
            <SelectField
              label={t('products.fields.baseUnit')}
              options={unitOptions}
              {...register('baseUnitId', {
                onChange: () => {
                  refillFactors(getValues('baseUnitId'));
                },
              })}
              error={errors.baseUnitId?.message}
            />
            {packArray.fields.length > 0 && (
              <ul aria-label={t('products.packs.label')} className="grid gap-3">
                {packArray.fields.map((pack, index) => {
                  const number = index + 1;
                  const unitId = packs[index]?.unitId ?? '';
                  const standard = standardOf(unitId, baseUnitId);
                  const packErrors = errors.units?.[index];
                  return (
                    <li
                      key={pack.id}
                      aria-label={t('products.packs.number', { number })}
                      className="grid grid-cols-1 gap-3 rounded-control border border-line p-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] sm:items-start"
                    >
                      <div className="grid gap-1.5">
                        <label
                          htmlFor={`units.${String(index)}.unitId`}
                          className="text-label font-medium"
                        >
                          {t('products.packs.unit')}
                        </label>
                        <Select
                          id={`units.${String(index)}.unitId`}
                          options={[
                            { value: '', label: t('products.packs.placeholder') },
                            ...unitOptions,
                          ]}
                          invalid={packErrors?.unitId !== undefined}
                          {...register(rowPath('units', index, 'unitId'), {
                            onChange: () => {
                              const next = standardOf(
                                getValues(rowPath('units', index, 'unitId')),
                                baseUnitId,
                              );
                              if (next !== null)
                                setValue(rowPath('units', index, 'factor'), plainFactor(next));
                            },
                          })}
                        />
                        <LineError
                          id={`units.${String(index)}.unitId`}
                          error={packErrors?.unitId?.message}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <label
                          htmlFor={`units.${String(index)}.factor`}
                          className="text-label font-medium"
                        >
                          {t('products.packs.factor')}
                        </label>
                        <Input
                          id={`units.${String(index)}.factor`}
                          inputMode="decimal"
                          suffix={unitWord}
                          readOnly={standard !== null}
                          invalid={packErrors?.factor !== undefined}
                          {...register(rowPath('units', index, 'factor'))}
                        />
                        {standard !== null ? (
                          <p className="text-label text-ink-3">{t('products.packs.standard')}</p>
                        ) : (
                          <LineError
                            id={`units.${String(index)}.factor`}
                            error={packErrors?.factor?.message}
                          />
                        )}
                      </div>
                      {kind === 'simple' ? (
                        <div className="grid gap-1.5">
                          <label
                            htmlFor={`units.${String(index)}.barcode`}
                            className="text-label font-medium"
                          >
                            {t('products.packs.barcode')}
                          </label>
                          <Input
                            id={`units.${String(index)}.barcode`}
                            spellCheck={false}
                            invalid={packErrors?.barcode !== undefined}
                            {...register(rowPath('units', index, 'barcode'))}
                          />
                          <LineError
                            id={`units.${String(index)}.barcode`}
                            error={packErrors?.barcode?.message}
                          />
                        </div>
                      ) : (
                        <span className="hidden sm:block" />
                      )}
                      <IconButton
                        icon={Delete02Icon}
                        label={t('products.packs.remove', { number })}
                        className="justify-self-end sm:mt-[26px]"
                        onClick={() => {
                          packArray.remove(index);
                        }}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  packArray.append({ unitId: '', factor: '', barcode: '' });
                }}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
                {t('products.packs.add')}
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
              <SelectField
                label={t('products.fields.salesUnit')}
                options={defaultUnitOptions}
                {...register('salesUnitId')}
                error={errors.salesUnitId?.message}
              />
              <SelectField
                label={t('products.fields.purchaseUnit')}
                options={defaultUnitOptions}
                {...register('purchaseUnitId')}
                error={errors.purchaseUnitId?.message}
              />
            </div>
          </SectionCard>

          <SectionCard
            title={t('products.sections.variants')}
            subtitle={t('products.sections.variantsHint')}
          >
            <div className="grid gap-1.5">
              <div>
                <SegmentedControl
                  label={t('products.kindLabel')}
                  value={kind}
                  options={KINDS.map((value) => ({ value, label: t(`products.kinds.${value}`) }))}
                  onChange={(next) => {
                    if (next === 'simple' && variantArray.fields.length > 1) return;
                    switchKind(next);
                  }}
                />
              </div>
              {kind === 'variants' && variantArray.fields.length > 1 && (
                <p className="text-label text-ink-3">{t('products.simpleLocked')}</p>
              )}
            </div>

            {kind === 'simple' ? (
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-3 sm:gap-x-4">
                <TextField
                  label={t('products.fields.sku')}
                  optional
                  hint={t('products.fields.skuHint')}
                  spellCheck={false}
                  {...register('variants.0.sku')}
                  error={errors.variants?.[0]?.sku?.message}
                />
                <TextField
                  label={t('products.fields.barcode')}
                  optional
                  spellCheck={false}
                  {...register('variants.0.barcode')}
                  error={errors.variants?.[0]?.barcode?.message}
                />
                <FormField
                  control={control}
                  name="variants.0.salePrice"
                  label={t('products.fields.price', { unit: unitWord })}
                  hint={priceHint}
                  optional
                >
                  {(field) => <MoneyInput {...field} value={field.value ?? ''} />}
                </FormField>
              </div>
            ) : (
              <>
                <ul className="grid gap-3">
                  {optionArray.fields.map((option, index) => {
                    const number = index + 1;
                    const optionErrors = errors.options?.[index];
                    const valuesError =
                      optionErrors?.values?.message ??
                      optionErrors?.values?.root?.message ??
                      optionErrors?.values?.find?.((value) => value?.message)?.message;
                    return (
                      <li
                        key={option.id}
                        className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-start"
                      >
                        <div className="grid gap-1.5">
                          <label
                            htmlFor={`options.${String(index)}.name`}
                            className="text-label font-medium"
                          >
                            {t('products.options.name')}
                          </label>
                          <Input
                            id={`options.${String(index)}.name`}
                            placeholder={t('products.options.namePlaceholder')}
                            invalid={optionErrors?.name !== undefined}
                            {...register(rowPath('options', index, 'name'))}
                          />
                          <LineError
                            id={`options.${String(index)}.name`}
                            error={optionErrors?.name?.message}
                          />
                        </div>
                        <Controller
                          control={control}
                          name={rowPath('options', index, 'values')}
                          render={({ field }) => (
                            <div className="grid gap-1.5">
                              <label
                                htmlFor={`options.${String(index)}.values`}
                                className="text-label font-medium"
                              >
                                {t('products.options.values')}
                              </label>
                              <ValuesInput
                                id={`options.${String(index)}.values`}
                                value={field.value}
                                onChange={field.onChange}
                                invalid={valuesError !== undefined}
                              />
                              {valuesError ? (
                                <LineError
                                  id={`options.${String(index)}.values`}
                                  error={valuesError}
                                />
                              ) : (
                                <p className="text-label text-ink-3">
                                  {t('products.options.valuesHint')}
                                </p>
                              )}
                            </div>
                          )}
                        />
                        <IconButton
                          icon={Delete02Icon}
                          label={t('products.options.remove', { number })}
                          className="justify-self-end sm:mt-[26px]"
                          disabled={optionArray.fields.length <= 1}
                          onClick={() => {
                            optionArray.remove(index);
                          }}
                        />
                      </li>
                    );
                  })}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={optionArray.fields.length >= MAX_PRODUCT_OPTIONS}
                    onClick={() => {
                      optionArray.append({ name: '', values: [] });
                    }}
                  >
                    <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
                    {t('products.options.add')}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={createVariants}>
                    <HugeiconsIcon icon={GridViewIcon} size={16} strokeWidth={1.5} />
                    {t('products.options.generate')}
                  </Button>
                </div>
                <p className="text-label text-ink-3">{t('products.options.generateHint')}</p>
                <VariantRows
                  control={control}
                  register={register}
                  fields={variantArray.fields}
                  errors={errors.variants}
                  hasOptions={options.length > 0}
                  unitWord={unitWord}
                  onRemove={(index) => {
                    variantArray.remove(index);
                  }}
                />
                <p className="text-label text-ink-3">{priceHint}</p>
              </>
            )}
            {variantsError && (
              <p className="flex items-center gap-1.5 text-label text-crit">
                <HugeiconsIcon
                  icon={Alert02Icon}
                  size={15}
                  strokeWidth={1.5}
                  className="shrink-0"
                />
                {errorText(variantsError)}
              </p>
            )}
          </SectionCard>

          {type !== 'service' && (
            <SectionCard
              title={t('products.sections.tracking')}
              subtitle={t('products.sections.trackingHint')}
            >
              <SelectField
                label={t('products.fields.tracking')}
                hint={t(`products.trackingHints.${tracking}`)}
                options={TRACKING_MODES.map((value) => ({
                  value,
                  label: t(`products.trackings.${value}`),
                }))}
                {...register('tracking', {
                  onChange: () => {
                    if (getValues('tracking') !== 'batch') setValue('hasExpiry', false);
                  },
                })}
                error={errors.tracking?.message}
              />
              {tracking === 'batch' && (
                <Controller
                  control={control}
                  name="hasExpiry"
                  render={({ field }) => (
                    <Checkbox
                      id="hasExpiry"
                      label={t('products.fields.hasExpiry')}
                      checked={field.value}
                      onCheckedChange={(checked) => {
                        field.onChange(checked === true);
                      }}
                    />
                  )}
                />
              )}
            </SectionCard>
          )}

          {fields.length > 0 && (
            <SectionCard
              title={t('products.sections.details')}
              subtitle={t('products.sections.detailsHint')}
              className="sm:grid-cols-2 sm:gap-x-4"
            >
              {fields.map((field) => (
                <CustomFieldInput key={field.id} control={control} field={field} />
              ))}
            </SectionCard>
          )}

          {canManage && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {product && (
                // Left, away from Save. Delete takes two clicks: it cannot be undone.
                <div className="mr-auto flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    disabled={toggle.isPending}
                    onClick={() => {
                      toggle.mutate(product);
                    }}
                  >
                    {product.archivedAt === null ? t('products.archive') : t('products.restore')}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (confirming) remove.mutate(product);
                      else setConfirming(true);
                    }}
                  >
                    {confirming
                      ? t('products.confirmDelete', { code: product.code })
                      : t('products.delete')}
                  </Button>
                  {confirming && (
                    <span className="text-body-sm text-ink-2">{t('products.deleteWarning')}</span>
                  )}
                </div>
              )}
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? t('products.saving')
                  : product
                    ? t('products.save')
                    : t('products.create')}
              </Button>
            </div>
          )}
        </fieldset>
      </form>
    </div>
  );
}

// One template for the header and every variant row, so the columns line up: values, SKU,
// barcode, price, archived, remove. minmax(0, …) here and grid-cols-1 in each cell (as in Field): a
// column may then shrink below an <input>'s own default width — without them the price box ran
// into the Archived box (found on the 1280px screenshot).
const VARIANT_COLUMNS =
  '@3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1fr)_7rem_2.25rem]';

// The variants of a product with options: one row each, labelled by its values ("M / Navy blue")
function VariantRows({
  control,
  register,
  fields,
  errors,
  hasOptions,
  unitWord,
  onRemove,
}: {
  control: Control<FormValues, unknown, z.output<ReturnType<typeof formSchema>>>;
  register: ReturnType<
    typeof useForm<FormValues, unknown, z.output<ReturnType<typeof formSchema>>>
  >['register'];
  fields: readonly { id: string }[];
  errors: ReturnType<
    typeof useForm<FormValues, unknown, z.output<ReturnType<typeof formSchema>>>
  >['formState']['errors']['variants'];
  hasOptions: boolean;
  unitWord: string;
  onRemove: (index: number) => void;
}) {
  const { t } = useLocale();
  const variants = useWatch({ control, name: 'variants' });
  if (!hasOptions || fields.length === 0 || variants.every((v) => v.optionValues.length === 0)) {
    return <p className="text-body-sm text-ink-3">{t('products.variantsTable.empty')}</p>;
  }
  return (
    // A container query, like the journal lines: the card's width, not the screen's, decides
    // whether a row fits on one line (the sidebar takes 244px of a desktop screen)
    <div className="@container grid gap-2">
      <div
        aria-hidden="true"
        className={cn(
          'hidden gap-3 px-3 text-caption font-medium text-ink-3 @3xl:grid',
          VARIANT_COLUMNS,
        )}
      >
        <span>{t('products.variantsTable.variant')}</span>
        <span>{t('products.fields.sku')}</span>
        <span>{t('products.fields.barcode')}</span>
        <span className="text-right">{t('products.fields.price', { unit: unitWord })}</span>
        {/* The checkbox in each row says "Archived" itself */}
        <span />
      </div>
      <ul aria-label={t('products.variantsTable.label')} className="grid gap-3">
        {fields.map((row, index) => {
          const values = variants[index]?.optionValues ?? [];
          const name = values.join(' / ');
          const rowErrors = errors?.[index];
          const id = (part: string) => `variants.${String(index)}.${part}`;
          return (
            <li
              key={row.id}
              role="group"
              aria-label={name}
              className={cn(
                'grid grid-cols-2 gap-3 rounded-control border border-line p-3 @3xl:items-start',
                VARIANT_COLUMNS,
              )}
            >
              <div className="col-span-2 grid min-w-0 grid-cols-1 content-start gap-1 @3xl:col-span-1 @3xl:pt-2.5">
                <span className="text-body-sm font-medium">{name}</span>
                <LineError id={id('optionValues')} error={rowErrors?.optionValues?.message} />
              </div>
              <div className="col-span-2 grid min-w-0 grid-cols-1 gap-1.5 @3xl:col-span-1">
                <label htmlFor={id('sku')} className="text-label font-medium @3xl:sr-only">
                  {t('products.fields.sku')}
                </label>
                <Input
                  id={id('sku')}
                  spellCheck={false}
                  placeholder={t('products.fields.sku')}
                  invalid={rowErrors?.sku !== undefined}
                  {...register(rowPath('variants', index, 'sku'))}
                />
                <LineError id={id('sku')} error={rowErrors?.sku?.message} />
              </div>
              <div className="col-span-2 grid min-w-0 grid-cols-1 gap-1.5 @3xl:col-span-1">
                <label htmlFor={id('barcode')} className="text-label font-medium @3xl:sr-only">
                  {t('products.fields.barcode')}
                </label>
                <Input
                  id={id('barcode')}
                  spellCheck={false}
                  placeholder={t('products.fields.barcode')}
                  invalid={rowErrors?.barcode !== undefined}
                  {...register(rowPath('variants', index, 'barcode'))}
                />
                <LineError id={id('barcode')} error={rowErrors?.barcode?.message} />
              </div>
              <Controller
                control={control}
                name={rowPath('variants', index, 'salePrice')}
                render={({ field, fieldState }) => (
                  <div className="col-span-2 grid min-w-0 grid-cols-1 gap-1.5 @3xl:col-span-1">
                    <label
                      htmlFor={id('salePrice')}
                      className="text-label font-medium @3xl:sr-only"
                    >
                      {t('products.fields.price', { unit: unitWord })}
                    </label>
                    <MoneyInput
                      id={id('salePrice')}
                      name={field.name}
                      ref={field.ref}
                      value={field.value ?? ''}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      invalid={fieldState.error !== undefined}
                    />
                    <LineError id={id('salePrice')} error={fieldState.error?.message} />
                  </div>
                )}
              />
              <Controller
                control={control}
                name={rowPath('variants', index, 'archived')}
                render={({ field }) => (
                  <div className="@3xl:pt-2.5">
                    <Checkbox
                      id={id('archived')}
                      label={t('products.variantsTable.archived')}
                      checked={field.value}
                      onCheckedChange={(checked) => {
                        field.onChange(checked === true);
                      }}
                    />
                  </div>
                )}
              />
              <IconButton
                icon={Delete02Icon}
                label={t('products.variantsTable.remove', { name })}
                className="justify-self-end"
                onClick={() => {
                  onRemove(index);
                }}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
