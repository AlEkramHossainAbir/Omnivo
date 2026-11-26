import {
  Alert02Icon,
  InformationCircleIcon,
  MinusSignIcon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  addQuantity,
  compareQuantity,
  contractErrorMap,
  isQuantity,
  partlyDeliverStorefrontOrderInputSchema,
  routes,
  type StorefrontOrder,
  type StorefrontReturnPlan,
  subtractQuantity,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Checkbox,
  CheckboxGroup,
  DialogClose,
  DialogContent,
  Field,
  FormAlert,
  MoneyInput,
  parseIsoDate,
  TextAreaField,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiRequestError, call } from '../lib/api';
import {
  asksCollected,
  decimalsOf,
  doorParcel,
  plainMoney,
  plainQuantity,
  storefrontReturnPlanQuery,
} from '../lib/storefront-orders';
import { useTenantId } from '../lib/workspace';
import { collectedOver } from './storefront-order-door';
import { useShopMoney } from './storefront-parts';

// Step 28b.6: "Record what came back" (decision 6, approved with the mockup), a chunk of its own,
// loaded when the button is pressed: most shipped orders are delivered whole. One row per challan
// line (the return plan), in the challan's order. A ticked row says how many came back (a stepper,
// 1 to what the line took) or, for a serial product, which pieces (one tick each). Only the ticked
// rows are sent (mine 16). The POS return's line rows, without its money: what the shopper kept is
// worked out by the API from the order's own prices.

type PlanLine = StorefrontReturnPlan['lines'][number];

// What a ticked row holds: the box's text as typed, and the serial numbers ticked
interface Pick {
  quantity: string;
  serials: string[];
}

// Errors by the API's path ("lines", "lines.0.quantity", "collectedAmount"), as codes. The paths
// of the lines are by the place in the body, which has only the ticked rows: `sent` maps them back
type Errors = Record<string, string>;

function firstPick(line: PlanLine): Pick {
  // A serial line starts with nothing ticked (the member names the pieces); another with one
  return line.tracking === 'serial'
    ? { quantity: '0', serials: [] }
    : { quantity: '1', serials: [] };
}

export function CameBackDialog({
  order,
  onDone,
}: {
  order: StorefrontOrder;
  onDone: (saved: StorefrontOrder) => Promise<void>;
}) {
  const { t } = useLocale();
  const { data: plan, isError } = useQuery(storefrontReturnPlanQuery(useTenantId(), order.id));
  return (
    <DialogContent
      // The Packed dialog's width: a row has a name, a batch and a stepper
      className="max-w-[560px]"
      title={t('storefront.order.cameBack.title', { number: order.orderNo })}
      description={
        plan
          ? t('storefront.order.cameBack.description', { warehouse: plan.warehouse.name })
          : undefined
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="came-back" disabled={!plan}>
            {t('storefront.order.cameBack.submit')}
          </Button>
        </>
      }
    >
      {isError ? (
        <FormAlert message={t('storefront.order.cameBack.loadFailed')} />
      ) : (
        plan && <CameBackForm order={order} plan={plan} onDone={onDone} />
      )}
    </DialogContent>
  );
}

function CameBackForm({
  order,
  plan,
  onDone,
}: {
  order: StorefrontOrder;
  plan: StorefrontReturnPlan;
  onDone: (saved: StorefrontOrder) => Promise<void>;
}) {
  const { t, errorText } = useLocale();
  const money = useShopMoney();
  const door = doorParcel(order);
  const asks = asksCollected(door);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  // What the courier said the rider collected for what the shopper kept. Without it the box starts
  // empty: the whole parcel's amount would be wrong for a part of it, and the API asks for it
  // (storefront_order_collected_required)
  const [collected, setCollected] = useState(
    asks && door.collectedAmount !== null ? plainMoney(door.collectedAmount) : '',
  );
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [sending, setSending] = useState(false);
  // The ticked rows in the order they were sent, so "lines.1.quantity" finds its row
  const [sent, setSent] = useState<string[]>([]);
  // Ticked serial rows with no piece ticked (mine 49). Their count would be 0, which the contract
  // refuses as a quantity ("Enter a number above zero"), words that make no sense under ticks
  const [noSerials, setNoSerials] = useState<string[]>([]);

  const pick = (line: PlanLine, next: Pick | null) => {
    const others = Object.fromEntries(
      Object.entries(picks).filter(([id]) => id !== line.deliveryLineId),
    );
    setPicks(next ? { ...others, [line.deliveryLineId]: next } : others);
  };

  // The body, from the ticked rows in the challan's order. A serial row's quantity is its count
  const body = () => {
    const ticked = plan.lines.filter((line) => picks[line.deliveryLineId] !== undefined);
    return {
      ids: ticked.map((line) => line.deliveryLineId),
      input: {
        version: order.version,
        lines: ticked.map((line) => {
          const chosen = picks[line.deliveryLineId] ?? firstPick(line);
          return line.tracking === 'serial'
            ? {
                deliveryLineId: line.deliveryLineId,
                quantity: String(chosen.serials.length),
                serialNumbers: chosen.serials,
              }
            : {
                deliveryLineId: line.deliveryLineId,
                quantity: chosen.quantity.trim(),
                serialNumbers: [],
              };
        }),
        // Not asked (no COD account, or nothing to collect): left to the API
        collectedAmount: asks ? collected : '',
        reason,
      },
    };
  };

  const submit = async () => {
    const { ids, input } = body();
    setSent(ids);
    const empty = plan.lines
      .filter(
        (line) => line.tracking === 'serial' && picks[line.deliveryLineId]?.serials.length === 0,
      )
      .map((line) => line.deliveryLineId);
    setNoSerials(empty);
    if (empty.length > 0) {
      setErrors({});
      return;
    }
    // The contract's own rules first (nothing ticked, a box that is not a quantity), with the
    // same paths as the API's answer
    const parsed = partlyDeliverStorefrontOrderInputSchema.safeParse(input, {
      error: contractErrorMap,
    });
    if (!parsed.success) {
      const found: Errors = {};
      for (const issue of parsed.error.issues) found[issue.path.join('.')] ??= issue.message;
      setErrors(found);
      return;
    }
    setErrors({});
    setSending(true);
    try {
      const saved = await call(routes.storefrontOrderDeliveries.partlyDeliverOrder, {
        params: { id: order.id },
        body: parsed.data,
      });
      await onDone(saved);
    } catch (error) {
      if (!(error instanceof ApiRequestError)) {
        setErrors({ '': 'unknown_error' });
      } else {
        const fieldErrors = Object.entries(error.problem.fieldErrors ?? {}).flatMap(
          ([path, codes]) => (codes[0] === undefined ? [] : [[path, codes[0]] as const]),
        );
        const found: Errors =
          fieldErrors.length > 0 ? Object.fromEntries(fieldErrors) : { '': error.code };
        // Written out with its amount, as Mark delivered does (storefront-order-door.tsx): the
        // Field shows a code without its params
        if (collectedOver(error) && door !== null) {
          found.collectedAmount = errorText('storefront_order_collected_over', {
            amount: money(door.codAmount),
          });
        }
        setErrors(found);
      }
    } finally {
      setSending(false);
    }
  };

  // A row's own error: its quantity or its serial numbers, by its place in what was sent
  const rowError = (line: PlanLine): string | undefined => {
    const index = sent.indexOf(line.deliveryLineId);
    if (index === -1) return undefined;
    return Object.entries(errors).find(([path]) => path.startsWith(`lines.${String(index)}.`))?.[1];
  };

  return (
    <form
      id="came-back"
      noValidate
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!sending) void submit();
      }}
    >
      {errors[''] !== undefined && <FormAlert message={errors['']} />}
      <div className="grid gap-1.5">
        <ul className="divide-y divide-line overflow-hidden rounded-control border border-line">
          {plan.lines.map((line) => (
            <CameBackRow
              key={line.deliveryLineId}
              line={line}
              pick={picks[line.deliveryLineId] ?? null}
              onPick={(next) => {
                pick(line, next);
              }}
              error={rowError(line)}
              noSerials={noSerials.includes(line.deliveryLineId)}
            />
          ))}
        </ul>
        {/* storefront_order_return_nothing / return_everything: about the lines as a whole */}
        {errors.lines !== undefined && <LinesError code={errors.lines} />}
      </div>
      {asks && (
        <Field
          id="came-back-collected"
          label={t('storefront.order.cameBack.collected')}
          hint={t('storefront.order.cameBack.collectedHint', { amount: money(door.codAmount) })}
          error={errors.collectedAmount}
        >
          <MoneyInput
            id="came-back-collected"
            value={collected}
            onChange={setCollected}
            invalid={errors.collectedAmount !== undefined}
          />
          {door.collectedAmount !== null && (
            <p className="flex items-start gap-1.5 text-label text-ink-2">
              <HugeiconsIcon
                icon={InformationCircleIcon}
                size={15}
                strokeWidth={1.5}
                className="mt-0.5 shrink-0 text-ink-3"
              />
              {t('storefront.order.cameBack.collectedFromCourier', {
                courier: door.account.name,
                amount: money(door.collectedAmount),
              })}
            </p>
          )}
        </Field>
      )}
      <TextAreaField
        id="came-back-reason"
        label={t('storefront.order.cameBack.reason')}
        optional
        placeholder={t('storefront.order.cameBack.reasonPlaceholder')}
        hint={t('storefront.order.cameBack.reasonHint')}
        maxLength={200}
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
        }}
        error={errors.reason}
      />
    </form>
  );
}

function LinesError({ code }: { code: string }) {
  const { errorText } = useLocale();
  return <p className="text-label text-crit">{errorText(code)}</p>;
}

function CameBackRow({
  line,
  pick,
  onPick,
  error,
  noSerials,
}: {
  line: PlanLine;
  pick: Pick | null;
  onPick: (pick: Pick | null) => void;
  error: string | undefined;
  noSerials: boolean;
}) {
  const { t, format, errorText } = useLocale();
  const id = `came-back-${line.deliveryLineId}`;
  const sentQuantity = plainQuantity(line.quantity);
  const decimals = decimalsOf(line.quantity);
  const expires = line.batch?.expiresOn ? parseIsoDate(line.batch.expiresOn) : undefined;
  const details = [
    t('storefront.order.cameBack.sent', {
      quantity: `${format.number(sentQuantity, decimals)} ${line.unitCode}`,
    }),
    line.batch === null
      ? ''
      : expires
        ? t('storefront.order.cameBack.batchExpires', {
            lot: line.batch.lotNumber,
            date: format.date(expires),
          })
        : t('storefront.order.cameBack.batch', { lot: line.batch.lotNumber }),
  ].filter((part) => part !== '');

  // The arrows move by one piece, never below one, never above what the line took
  const step = (by: number) => {
    if (!pick) return;
    const now = isQuantity(pick.quantity) ? pick.quantity : '0';
    const next = by > 0 ? addQuantity(now, '1') : subtractQuantity(now, '1');
    if (compareQuantity(next, '1') < 0 || compareQuantity(next, line.quantity) > 0) return;
    onPick({ ...pick, quantity: plainQuantity(next) });
  };

  return (
    <li className="grid gap-2.5 px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        {/* The checkbox's name says the product ("Came back: Neem face wash"); the visible
            label beside it is the name and the details, so the label is for screen readers */}
        <Checkbox
          id={id}
          label={t('storefront.order.cameBack.take', { name: line.name })}
          hideLabel
          checked={pick !== null}
          onCheckedChange={(checked) => {
            onPick(checked === true ? firstPick(line) : null);
          }}
        />
        <label htmlFor={id} className="grid min-w-0 flex-1">
          <span className="text-body-sm font-medium text-ink">{line.name}</span>
          <span className="text-caption text-ink-3 tabular-nums">
            <span className="font-mono">{line.sku}</span>
            {line.packSize !== '' && ` · ${line.packSize}`}
            {` · ${details.join(' · ')}`}
          </span>
        </label>
      </div>
      {pick && line.tracking !== 'serial' && (
        <div className="flex flex-wrap items-center gap-2.5 pl-[27px]">
          <label htmlFor={`${id}-quantity`} className="text-label font-medium text-ink-2">
            {t('storefront.order.cameBack.quantity')}
          </label>
          <span className="inline-flex items-center rounded-control border border-line-strong bg-surface">
            <button
              type="button"
              aria-label={`${t('storefront.order.cameBack.quantity')} −1`}
              onClick={() => {
                step(-1);
              }}
              className="grid size-8 place-items-center text-ink-2 hover:text-ink"
            >
              <HugeiconsIcon icon={MinusSignIcon} size={14} strokeWidth={1.5} />
            </button>
            <input
              id={`${id}-quantity`}
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={error !== undefined}
              value={pick.quantity}
              onChange={(event) => {
                onPick({ ...pick, quantity: event.target.value });
              }}
              className="w-14 bg-transparent text-center text-body-sm font-medium tabular-nums outline-none"
            />
            <button
              type="button"
              aria-label={`${t('storefront.order.cameBack.quantity')} +1`}
              onClick={() => {
                step(1);
              }}
              className="grid size-8 place-items-center text-ink-2 hover:text-ink"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.5} />
            </button>
          </span>
          <span className="text-label text-ink-3">{line.unitCode}</span>
          {error !== undefined && (
            <span className="w-full text-label text-crit">{errorText(error)}</span>
          )}
        </div>
      )}
      {pick && line.tracking === 'serial' && (
        <div className="pl-[27px]">
          <CheckboxGroup
            legend={t('storefront.order.cameBack.serials')}
            options={line.serialNumbers.map((serial) => ({
              value: serial,
              label: <span className="font-mono">{serial}</span>,
            }))}
            value={pick.serials}
            onChange={(serials) => {
              onPick({ ...pick, serials });
            }}
            error={error}
          />
          {noSerials && error === undefined && (
            // The look of a field's error (CheckboxGroup's own takes an error code only)
            <p className="mt-1.5 flex items-center gap-1.5 text-label text-crit">
              <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
              {t('storefront.order.cameBack.serialsNone')}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
