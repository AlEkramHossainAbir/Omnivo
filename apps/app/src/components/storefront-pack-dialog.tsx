import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  Image01Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  contractErrorMap,
  packStorefrontOrderInputSchema,
  routes,
  type StorefrontOrder,
  type StorefrontPackPlan,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  cn,
  DialogClose,
  DialogContent,
  Field,
  FormAlert,
  IconButton,
  Input,
  Select,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useId, useState } from 'react';

import { ApiRequestError, call } from '../lib/api';
import {
  decimalsOf,
  packFormValues,
  type PackLineValues,
  pickedOf,
  plainQuantity,
  storefrontPackPlanQuery,
  toPackInput,
} from '../lib/storefront-orders';
import { useTenantId } from '../lib/workspace';
import { SerialNumbersInput } from './serial-numbers-input';

// Step 27b: "Mark packed" (decisions 5, 14, 15, 32). The dialog asks the API what to pack (the
// warehouse the stock is held in, each line's batches with stock there, and a first-expiry-first
// suggestion), lets the packer change the batches or type the serial numbers, and sends every line
// once. Whether the picks add up and the batches have the stock is the API's to say: its errors
// come back with the same paths as the contract's (lines.0.picks.1.quantity) and show under the box.

// The most picks a line may have (the contract's own limit)
const MAX_PICKS = 20;

// The paths this dialog has a place for. Anything else the API names shows above the lines, so no
// refusal is ever silent
const PLACED = /^lines\.\d+\.(position|picks(\.\d+\.(batchId|quantity|serialNumbers(\.\d+)?))?)$/;

type Errors = Record<string, string>;

// One error code per path, the first one, as the forms do
function errorsOf(fieldErrors: Record<string, string[]> | undefined): Errors {
  return Object.fromEntries(
    Object.entries(fieldErrors ?? {}).flatMap(([path, codes]) =>
      codes[0] === undefined ? [] : [[path, codes[0]]],
    ),
  );
}

function FieldError({ code }: { code: string | undefined }) {
  const { errorText } = useLocale();
  if (code === undefined) return null;
  return (
    <span className="flex items-start gap-1.5 text-label text-crit">
      <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="mt-px shrink-0" />
      {errorText(code)}
    </span>
  );
}

// "2 of 3 pcs picked": good with a tick when the picks are exactly the line, ink-3 otherwise. The
// words carry the meaning; the color only repeats it
function Count({ complete, children }: { complete: boolean; children: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-label tabular-nums',
        complete ? 'text-good' : 'text-ink-3',
      )}
    >
      {complete && <HugeiconsIcon icon={CheckmarkCircle02Icon} size={14} strokeWidth={1.5} />}
      {children}
    </span>
  );
}

function PackLine({
  index,
  planned,
  warehouse,
  image,
  values,
  errors,
  onChange,
}: {
  index: number;
  planned: StorefrontPackPlan['lines'][number];
  warehouse: string;
  image: string | null;
  values: PackLineValues;
  errors: Errors;
  onChange: (next: PackLineValues) => void;
}) {
  const { t, format } = useLocale();
  const id = useId();
  const quantityText = (value: string) =>
    `${format.number(value, decimalsOf(value))} ${planned.unitCode}`;
  const needed = quantityText(planned.quantity);
  const at = `lines.${String(index)}`;
  // A serial number's error names its place in the list (…serialNumbers.2): one line under the box
  const serialError = Object.entries(errors).find(([path]) =>
    path.startsWith(`${at}.picks.0.serialNumbers`),
  )?.[1];

  const batchOptions = [
    { value: '', label: t('storefront.order.packing.batchPlaceholder') },
    ...planned.batches.map((batch) => {
      const available = quantityText(batch.available);
      return {
        value: batch.batchId,
        label:
          batch.expiresOn === null
            ? t('storefront.order.packing.batchOptionNoExpiry', {
                lot: batch.lotNumber,
                available,
              })
            : t('storefront.order.packing.batchOption', {
                lot: batch.lotNumber,
                // A day with no time: read with local date parts, never as UTC midnight
                date: format.date(new Date(`${batch.expiresOn}T00:00:00`)),
                available,
              }),
      };
    }),
  ];

  const setPick = (pickIndex: number, patch: Partial<PackLineValues['picks'][number]>) => {
    onChange({
      ...values,
      picks: values.picks.map((pick, i) => (i === pickIndex ? { ...pick, ...patch } : pick)),
    });
  };

  const { picked, complete } = pickedOf(values, planned.quantity);
  const serials = values.serials.length;
  const serialsNeeded = Number(plainQuantity(planned.quantity));

  return (
    <section
      aria-labelledby={`${id}-name`}
      className="grid gap-3 rounded-control border border-line p-4"
    >
      <header className="flex items-start gap-3">
        {image === null ? (
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-subtle text-ink-3">
            <HugeiconsIcon icon={Image01Icon} size={16} strokeWidth={1.5} />
          </span>
        ) : (
          <img
            src={image}
            alt=""
            className="size-10 shrink-0 rounded-lg border border-line bg-surface object-contain"
          />
        )}
        <span className="grid min-w-0 flex-1">
          <span id={`${id}-name`} className="text-body-sm font-medium text-ink">
            {planned.name}
          </span>
          <span className="truncate text-caption text-ink-3">
            <span className="font-mono">{planned.sku}</span>
            {planned.packSize !== '' && ` · ${planned.packSize}`}
          </span>
        </span>
        <span className="shrink-0 text-label text-ink-2 tabular-nums">
          {t('storefront.order.packing.needs', { quantity: needed })}
        </span>
      </header>
      <FieldError code={errors[`${at}.position`]} />

      {planned.tracking === 'none' && (
        <p className="text-body-sm text-ink-2">{t('storefront.order.packing.untracked')}</p>
      )}

      {planned.tracking === 'serial' && (
        <div className="grid gap-1.5">
          {/* The serial box every stock document uses (Geist Mono, one per line, a scanner's
              Enter starts the next), inside a Field for its label, hint and error */}
          <Field
            id={`${id}-serials`}
            label={t('storefront.order.packing.serials')}
            hint={t('storefront.order.packing.serialsHint', {
              needed: format.number(serialsNeeded),
            })}
            error={serialError}
          >
            <SerialNumbersInput
              id={`${id}-serials`}
              value={values.serials}
              invalid={serialError !== undefined}
              aria-describedby={`${id}-serials-${serialError === undefined ? 'hint' : 'error'}`}
              onChange={(serialNumbers) => {
                onChange({ ...values, serials: serialNumbers });
              }}
            />
          </Field>
          <span className="justify-self-end">
            <Count complete={serials === serialsNeeded}>
              {t('storefront.order.packing.serialsCount', {
                entered: format.number(serials),
                needed: format.number(serialsNeeded),
              })}
            </Count>
          </span>
        </div>
      )}

      {planned.tracking === 'batch' && (
        <div className="grid gap-3">
          {/* Mark packed would fail on stock: say so before the packer tries */}
          {planned.batches.length === 0 && (
            <p className="flex items-start gap-1.5 text-label text-crit">
              <HugeiconsIcon
                icon={Alert02Icon}
                size={15}
                strokeWidth={1.5}
                className="mt-px shrink-0"
              />
              {t('storefront.order.packing.noBatches', { warehouse })}
            </p>
          )}
          <div
            aria-hidden="true"
            className="grid grid-cols-[minmax(0,1fr)_120px_36px] gap-x-2.5 text-label font-medium text-ink"
          >
            <span>{t('storefront.order.packing.batch')}</span>
            <span>{t('storefront.order.packing.quantity')}</span>
          </div>
          {values.picks.map((pick, pickIndex) => {
            const number = format.number(pickIndex + 1);
            const batchError = errors[`${at}.picks.${String(pickIndex)}.batchId`];
            const quantityError = errors[`${at}.picks.${String(pickIndex)}.quantity`];
            return (
              <div
                // The picks have no id of their own; their place is what the API's paths name too
                key={pickIndex}
                className="grid grid-cols-[minmax(0,1fr)_120px_36px] items-start gap-x-2.5 gap-y-1"
              >
                <Select
                  aria-label={`${t('storefront.order.packing.batch')} ${number}`}
                  options={batchOptions}
                  value={pick.batchId}
                  invalid={batchError !== undefined}
                  onChange={(event) => {
                    setPick(pickIndex, { batchId: event.target.value });
                  }}
                />
                <Input
                  aria-label={`${t('storefront.order.packing.quantity')} ${number}`}
                  inputMode="decimal"
                  autoComplete="off"
                  align="end"
                  suffix={planned.unitCode}
                  invalid={quantityError !== undefined}
                  value={pick.quantity}
                  onChange={(event) => {
                    setPick(pickIndex, { quantity: event.target.value });
                  }}
                />
                <IconButton
                  icon={Delete02Icon}
                  label={t('storefront.order.packing.removeBatch', { number })}
                  className="mt-[3px]"
                  // A line always has a pick: the contract needs one, and an empty line would
                  // only come back as storefront_order_pick_total
                  disabled={values.picks.length === 1}
                  onClick={() => {
                    onChange({ ...values, picks: values.picks.filter((_, i) => i !== pickIndex) });
                  }}
                />
                {(batchError !== undefined || quantityError !== undefined) && (
                  <span className="col-span-3 grid gap-1">
                    <FieldError code={batchError} />
                    <FieldError code={quantityError} />
                  </span>
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={values.picks.length >= MAX_PICKS || planned.batches.length === 0}
              onClick={() => {
                onChange({ ...values, picks: [...values.picks, { batchId: '', quantity: '' }] });
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('storefront.order.packing.addBatch')}
            </Button>
            <Count complete={complete}>
              {t('storefront.order.packing.picked', {
                // The unit once, after the line's quantity: "2 of 3 pcs picked"
                picked: format.number(picked, decimalsOf(picked)),
                quantity: needed,
              })}
            </Count>
          </div>
        </div>
      )}
      <FieldError code={errors[`${at}.picks`]} />
    </section>
  );
}

function PackForm({
  order,
  plan,
  onDone,
}: {
  order: StorefrontOrder;
  plan: StorefrontPackPlan;
  onDone: (saved: StorefrontOrder) => Promise<void>;
}) {
  const { t } = useLocale();
  const [lines, setLines] = useState(() => packFormValues(plan));
  const [errors, setErrors] = useState<Errors>({});
  const [rootError, setRootError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The order's photos, by line: the plan has the names, the order has the pictures
  const imageOf = useCallback(
    (position: number) =>
      order.lines.find((line) => line.position === position)?.image?.url ?? null,
    [order.lines],
  );

  const show = (found: Errors, code: string) => {
    setErrors(found);
    const unplaced = Object.keys(found).some((path) => !PLACED.test(path));
    setRootError(Object.keys(found).length === 0 || unplaced ? code : null);
  };

  const submit = async () => {
    // The contract's own checks first (a quantity typed wrong, a serial number twice), with the
    // same paths as the API's, so a mistake shows without a round trip
    const parsed = packStorefrontOrderInputSchema.safeParse(
      toPackInput(plan, lines, order.version),
      { error: contractErrorMap },
    );
    if (!parsed.success) {
      const found: Errors = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.join('.');
        found[path] ??= issue.message;
      }
      show(found, 'invalid_value');
      return;
    }
    setSaving(true);
    try {
      const saved = await call(routes.storefrontOrders.packOrder, {
        params: { id: order.id },
        body: parsed.data,
      });
      await onDone(saved);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        show(errorsOf(error.problem.fieldErrors), error.code);
      } else {
        show({}, 'unknown_error');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogContent
      className="max-w-[560px]"
      title={t('storefront.order.packing.title', { number: order.orderNo })}
      description={t('storefront.order.packing.description', { warehouse: plan.warehouse.name })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="pack-shop-order" disabled={saving}>
            {t('storefront.order.packing.submit')}
          </Button>
        </>
      }
    >
      <form
        id="pack-shop-order"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="grid gap-3"
      >
        {rootError !== null && <FormAlert message={rootError} />}
        {plan.lines.map((planned, index) => {
          const values = lines[index];
          if (values === undefined) return null;
          return (
            <PackLine
              key={planned.position}
              index={index}
              planned={planned}
              warehouse={plan.warehouse.name}
              image={imageOf(planned.position)}
              values={values}
              errors={errors}
              onChange={(next) => {
                setLines((current) => current.map((line, i) => (i === index ? next : line)));
              }}
            />
          );
        })}
      </form>
    </DialogContent>
  );
}

export function PackDialog({
  order,
  onDone,
}: {
  order: StorefrontOrder;
  onDone: (saved: StorefrontOrder) => Promise<void>;
}) {
  const { t } = useLocale();
  const plan = useQuery(storefrontPackPlanQuery(useTenantId(), order.id));
  if (plan.data) return <PackForm order={order} plan={plan.data} onDone={onDone} />;
  // Until the plan comes, the dialog's frame, so the button's press always opens something; when
  // it cannot come, the line that says to close and try again
  return (
    <DialogContent title={t('storefront.order.packing.title', { number: order.orderNo })}>
      {plan.isError && (
        <p role="alert" className="text-body-sm text-crit">
          {t('storefront.order.packing.loadFailed')}
        </p>
      )}
    </DialogContent>
  );
}
