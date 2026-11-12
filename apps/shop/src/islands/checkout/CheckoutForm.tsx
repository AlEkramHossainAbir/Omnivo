import { zodResolver } from '@hookform/resolvers/zod';
import {
  CheckmarkSquare02Icon,
  Loading03Icon,
  ShoppingCart01Icon,
  SquareIcon,
  Alert02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  contractErrorMap,
  type Problem,
  type ShopCartQuote,
  type ShopPaymentMethod,
} from '@omnivo/contracts';
import type { Language } from '@omnivo/i18n';
import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { removeFromCart, type CartLine } from '../../lib/cart';
import { shopMoney } from '../../lib/money';
import { announceOrderConfirmed } from '../../lib/order-events';
import { placeOrder } from './api';
import {
  changedPrices,
  checkoutFormSchema,
  errorText,
  fill,
  orderRequest,
  parseCouponCode,
  refusalErrors,
  shortBy,
  type CheckoutFormInput,
  type CheckoutFormValues,
} from './checkout';
import { CheckoutLines, type ShownLine } from './CheckoutLines';
import { FieldError, RadioCards, TextField } from './fields';
import { useCart, useCheckoutQuote } from './hooks';
import { PromoBox } from './PromoBox';
import type { CheckoutChoice, CheckoutWords } from './words';

// Step 26c: /checkout's one React island (decision 1; Figma checkout_process 37:3765). Everything
// it shows comes as props from the Astro page (the words, the zones, the payment methods), so no
// translation code reaches the browser. The cart comes from this browser's storage, the prices
// from the server's quote; the island adds no money itself.
interface CheckoutFormProps {
  words: CheckoutWords;
  zones: CheckoutChoice[];
  payments: CheckoutChoice<ShopPaymentMethod>[];
  minimumOrder: string | null;
  language: Language;
  numberLocale: string;
}

// What stays on screen once the order is confirmed: the dialog opens over the checkout as it was
// (Figma confirmation_status), while the cart is already empty
interface Placed {
  quote: ShopCartQuote;
  lines: CartLine[];
}

export default function CheckoutForm({
  words,
  zones,
  payments,
  minimumOrder,
  language,
  numberLocale,
}: CheckoutFormProps) {
  const money = (value: string): string => shopMoney(value, language);
  const numbers = useMemo(() => new Intl.NumberFormat(numberLocale), [numberLocale]);
  const count = (value: number): string => numbers.format(value);

  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors, isSubmitting },
  } = useForm<CheckoutFormInput, unknown, CheckoutFormValues>({
    // contractErrorMap: Zod's own issues come out as our codes (`required`), so every message
    // is a code the words have a sentence for
    resolver: zodResolver(checkoutFormSchema, { error: contractErrorMap }),
    defaultValues: {
      name: '',
      phone: '',
      address: '',
      // No zone is picked for the shopper: a wrong guess would show a wrong delivery charge
      zoneId: '',
      // The first method the shop takes; the cards are the same price, so a default costs nothing
      paymentMethod: payments[0]?.id ?? 'cod',
      termsAccepted: false,
    },
  });
  const zoneId = useWatch({ control, name: 'zoneId' });
  const termsAccepted = useWatch({ control, name: 'termsAccepted' });

  const cart = useCart();
  // The promo box's text, and the code sent with every quote since Apply (decision 2)
  const [couponText, setCouponText] = useState('');
  const [couponCode, setCouponCode] = useState<string | undefined>(undefined);
  const [couponFormatError, setCouponFormatError] = useState(false);
  const [placed, setPlaced] = useState<Placed | null>(null);
  // The quote the shopper saw when Confirm Order was refused with shop_order_changed
  const [refusedQuote, setRefusedQuote] = useState<ShopCartQuote | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Going to /checkout/verify: the button keeps saying "Placing the order…" until the page goes
  const [leaving, setLeaving] = useState(false);

  // No more quotes once the order is placed: the cart is empty then, and the screen stays as it was
  const { state, pricing, retry, refresh } = useCheckoutQuote(
    placed ? null : cart,
    zoneId,
    couponCode,
  );

  const quote = placed?.quote ?? (state.status === 'ready' ? state.quote : null);
  const lines = placed?.lines ?? cart;

  // A cart emptied here, in the drawer or in another tab. Not before the browser has read the
  // stored cart (null), and not after the order: its cart is emptied on purpose
  if (placed === null && lines !== null && lines.length === 0) {
    return <EmptyCheckout words={words} />;
  }

  const quantities = new Map((lines ?? []).map((line) => [line.listingId, line.quantity]));
  // The quote's lines still in the cart, in the quote's order (the cart's order)
  const shown =
    quote?.lines.filter(
      (line): line is ShownLine => line.status !== 'unavailable' && quantities.has(line.listingId),
    ) ?? [];
  const outOfStock = shown.some((line) => line.status === 'out_of_stock');
  const changed =
    refusedQuote !== null && quote !== null && !pricing
      ? changedPrices(refusedQuote, quote)
      : new Map<string, string>();

  // What the last quote did with the code in the box: only an answer for this very code counts
  const couponResult =
    quote !== null && quote.coupon.status !== 'none' && quote.coupon.code === couponCode
      ? quote.coupon
      : null;
  const applying = couponCode !== undefined && couponResult === null && state.status !== 'failed';
  const busy = isSubmitting || leaving;
  // Confirm Order waits for an answer for this exact cart, zone and code. Every reason it is
  // disabled is on screen: the terms box, the grey amounts, the out-of-stock line, the minimum
  const canOrder =
    placed === null &&
    quote !== null &&
    !pricing &&
    quote.itemCount > 0 &&
    !outOfStock &&
    !quote.belowMinimum &&
    termsAccepted &&
    !busy;

  function applyCoupon(): void {
    const parsed = parseCouponCode(couponText);
    // null: an empty box, which does nothing and says nothing
    setCouponFormatError(parsed?.ok === false);
    if (!parsed?.ok) return;
    // The box shows the code as the shop writes it ("WELCOME10")
    setCouponText(parsed.code);
    setCouponCode(parsed.code);
  }

  function removeCoupon(): void {
    setCouponText('');
    setCouponCode(undefined);
    setCouponFormatError(false);
  }

  function showRefusal(problem: Problem, seen: ShopCartQuote): void {
    const { fields, general } = refusalErrors(problem);
    fields.forEach(({ field, code }, index) => {
      // The first field with an error gets the focus, like a refusal from the form's own check
      setError(field, { type: 'server', message: code }, { shouldFocus: index === 0 });
    });
    if (problem.code === 'shop_order_changed') {
      // Price the cart again; the lines whose price moved then say what it was (decision 10)
      setRefusedQuote(seen);
      refresh();
    } else if (problem.code === 'shop_order_below_minimum' || problem.code === 'shop_cart_empty') {
      refresh();
    }
    const minimum = problem.params?.minimum;
    setSubmitError(
      general === null
        ? null
        : errorText(words, general, {
            minimum: minimum === undefined ? '' : money(String(minimum)),
          }),
    );
  }

  const submit = handleSubmit(async (values) => {
    if (lines === null || quote === null || !canOrder) return;
    const request = orderRequest(values, lines, couponCode, quote);
    if (request === null) return;
    setSubmitError(null);
    setRefusedQuote(null);

    const result = await placeOrder(request);
    if (result.kind === 'failed') {
      setSubmitError(words.orderFailed);
      return;
    }
    if (result.kind === 'refused') {
      showRefusal(result.problem, quote);
      return;
    }
    const { answer } = result;
    if (answer.next === 'verify') {
      // Cash on Delivery: the order waits for its code. The cart stays until the code is right,
      // so a shopper who gives up on the code still has it
      setLeaving(true);
      window.location.assign('/checkout/verify');
      return;
    }
    // Confirmed at once (Mobile Banking in the mock): the screen stays as it is, the ordered
    // lines leave the cart, and the "Order Confirmed" dialog (26c.5) hears the event
    setPlaced({ quote, lines });
    removeFromCart(new Set(lines.map((line) => line.listingId)));
    announceOrderConfirmed({ orderNo: answer.orderNo, phone: answer.phone });
  });

  const errorOf = (code: string | undefined): string | undefined =>
    code === undefined ? undefined : errorText(words, code);

  return (
    // Figma: 848px wide, 36px under the header (16px on a phone), a 4px glass frame. Every gap
    // below is Figma's, measured between trimmed text boxes (trim-text, as on the product page):
    // the header is 65px tall, not the 78px a 30px line would make. Figma has 160px from the card
    // to the footer: the footer's own 80px top margin collapses into this 160px, it does not add
    <div className="mx-auto mt-4 max-w-[848px] rounded-2xl bg-card-glass p-1 md:mt-9 md:mb-40">
      <div className="rounded-t-xl bg-cream p-6 text-center">
        <h1 className="trim-text text-sf-title font-semibold">{words.heading}</h1>
      </div>
      {/* noValidate: the browser's own bubbles would show English on a Bangla shop */}
      <form
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
        // Figma: the body starts 36px under the header and ends 36px above the card's edge, both
        // counted from the card, so 32px inside the 4px frame at the sides and the bottom
        className="flex flex-col gap-8 p-5 md:px-8 md:pt-9 md:pb-8"
      >
        <div className="grid gap-8 md:grid-cols-2 md:gap-4">
          <TextField
            label={words.name}
            autoComplete="name"
            error={errorOf(errors.name?.message)}
            {...register('name')}
          />
          {/* type="tel": the phone keyboard. The schema takes "+880 1786-120356" or Bangla
              digits as they are, so the box asks for no format */}
          <TextField
            label={words.phone}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            error={errorOf(errors.phone?.message)}
            {...register('phone')}
          />
        </div>
        <TextField
          label={words.address}
          autoComplete="street-address"
          error={errorOf(errors.address?.message)}
          {...register('address')}
        />

        <RadioCards
          legend={words.zone}
          choices={zones}
          field={register('zoneId')}
          error={errorOf(errors.zoneId?.message)}
          hint={
            words.freeDeliveryFrom !== null && (
              <p className="trim-text mt-3 text-sf-small text-muted">{words.freeDeliveryFrom}</p>
            )
          }
        />

        {quote === null || lines === null ? (
          state.status === 'failed' ? (
            <QuoteFailed words={words} onRetry={retry} />
          ) : (
            <QuoteLoading words={words} />
          )
        ) : (
          // Figma: 36px from the location cards to the lines, 4px more than the form's gap
          <div className="mt-1">
            <CheckoutLines
              lines={shown}
              quantities={quantities}
              changed={changed}
              pricing={pricing}
              frozen={placed !== null}
              words={words}
              money={money}
              count={count}
            />
            <Totals
              quote={quote}
              couponCode={couponResult?.status === 'applied' ? couponResult.code : null}
              pricing={pricing}
              minimumOrder={minimumOrder}
              words={words}
              money={money}
            />
          </div>
        )}
        {/* "2 items are no longer sold…": nothing on screen says it, so a screen reader hears it */}
        <p role="status" className="sr-only">
          {state.status === 'ready' && state.removed > 0
            ? fill(
                new Intl.PluralRules(numberLocale).select(state.removed) === 'one'
                  ? words.removedOne
                  : words.removedOther,
                { count: count(state.removed) },
              )
            : ''}
        </p>

        <PromoBox
          words={words}
          money={money}
          text={couponText}
          onTextChange={(text) => {
            setCouponText(text);
            setCouponFormatError(false);
          }}
          onApply={applyCoupon}
          onRemove={removeCoupon}
          applying={applying}
          result={couponResult}
          formatError={couponFormatError ? errorText(words, 'shop_coupon_format') : null}
        />

        {/* Figma: 48px around the payment cards, 16px more than the form's gap */}
        <div className="mt-4">
          <RadioCards
            legend={words.payment}
            choices={payments}
            field={register('paymentMethod')}
            error={errorOf(errors.paymentMethod?.message)}
          />
        </div>

        <div className="mt-4 flex flex-col gap-6">
          <label className="flex cursor-pointer items-center gap-3 text-[18px] text-body">
            {/* The real checkbox stays for the keyboard and screen readers; the 20px icon is
                what shows (CLAUDE.md: CheckmarkSquare02 when ticked) */}
            <input type="checkbox" className="peer sr-only" {...register('termsAccepted')} />
            <span className="grid size-5 shrink-0 place-items-center rounded-sm text-brand peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand">
              <HugeiconsIcon
                icon={termsAccepted ? CheckmarkSquare02Icon : SquareIcon}
                size={20}
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </span>
            {/* Trimmed, so the row is the icon's 20px, as in Figma */}
            <span className="trim-text">
              {words.termsBefore}
              {/* A new tab: following the link must not lose what the shopper typed here */}
              <a
                href="/pages/terms"
                target="_blank"
                rel="noopener"
                className="underline underline-offset-3"
              >
                {words.termsLink}
              </a>
              {words.termsAfter}
            </span>
          </label>

          <div>
            {/* role="alert": the shopper pressed the button and waits for this answer. Always in
                the page, like the promo box's status, and 12px above the button only when it
                says something */}
            <div role="alert" className="not-empty:pb-3">
              {submitError !== null && <FieldError text={submitError} />}
            </div>
            <button
              type="submit"
              disabled={!canOrder}
              className="h-16 w-full rounded-sm bg-accent text-[18px] font-semibold transition-colors duration-150 not-disabled:hover:bg-brand not-disabled:hover:text-accent disabled:bg-canvas disabled:text-muted"
            >
              {busy ? words.placing : words.confirm}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

// The rows under the lines (Figma y 598–695): Discount (only with an applied code, decision 15),
// Delivery Charge between two rules, then Total. Figma has 24px between a rule and the trimmed text
// next to it, so the rows inside the rules are 24px apart too. The trim goes on the spans:
// text-box does not apply to a flex container, only to the block boxes inside it.
// The amounts are the quote's, grey while a newer cart is being priced
interface TotalsProps {
  quote: ShopCartQuote;
  couponCode: string | null;
  pricing: boolean;
  minimumOrder: string | null;
  words: CheckoutWords;
  money: (value: string) => string;
}

function Totals({ quote, couponCode, pricing, minimumOrder, words, money }: TotalsProps) {
  const amount = `tabular-nums transition-colors duration-150 ${pricing ? 'text-muted' : ''}`;
  const delivery =
    quote.deliveryCharge === null
      ? words.pickZone
      : quote.freeDelivery
        ? words.free
        : money(quote.deliveryCharge);
  return (
    // Figma: the first rule 30px under the lines, and 48px from Total to the promo box (the form's
    // 32px gap plus this 16px)
    <div className="mt-[30px] pb-4">
      <div className="flex flex-col gap-6 border-y border-rule py-6 font-semibold">
        {couponCode !== null && (
          <p className="flex items-center justify-between gap-4">
            <span className="trim-text">{fill(words.discount, { code: couponCode })}</span>
            {/* U+2212, the minus sign, not a hyphen: it is a sum, and it lines up with digits */}
            <span className={`trim-text ${amount}`}>−{money(quote.discount)}</span>
          </p>
        )}
        <p className="flex items-center justify-between gap-4">
          <span className="trim-text">{words.deliveryCharge}</span>
          <span className={`trim-text ${quote.deliveryCharge === null ? 'text-muted' : amount}`}>
            {delivery}
          </span>
        </p>
      </div>
      <p className="flex items-center justify-between gap-4 pt-6 text-sf-subtitle leading-5 font-bold">
        <span className="trim-text">{words.total}</span>
        <span className={`trim-text ${amount} ${pricing ? '' : 'text-price'}`}>
          {money(quote.total)}
        </span>
      </p>
      {/* Under the minimum: Confirm Order is disabled, and this says how much more to add */}
      {quote.belowMinimum && minimumOrder !== null && (
        <div className="mt-3">
          <FieldError
            text={fill(words.belowMinimum, {
              minimum: money(minimumOrder),
              more: money(shortBy(minimumOrder, quote.subtotal)),
            })}
          />
        </div>
      )}
    </div>
  );
}

function QuoteLoading({ words }: { words: CheckoutWords }) {
  return (
    <p
      role="status"
      className="flex items-center justify-center gap-2.5 py-10 font-medium text-muted"
    >
      <HugeiconsIcon
        icon={Loading03Icon}
        size={24}
        strokeWidth={1.5}
        className="animate-spin"
        aria-hidden="true"
      />
      {words.loading}
    </p>
  );
}

// The drawer's failed state at the lines' place: without prices nothing can be ordered
function QuoteFailed({ words, onRetry }: { words: CheckoutWords; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-6 py-6 text-center">
      <span className="grid size-16 place-items-center rounded-full bg-promo-soft text-promo">
        <HugeiconsIcon icon={Alert02Icon} size={28} strokeWidth={1.5} aria-hidden="true" />
      </span>
      <p className="max-w-80">{words.failed}</p>
      <button
        type="button"
        onClick={onRetry}
        className="h-11 rounded-sm bg-cream px-6 font-semibold transition-colors duration-150 hover:bg-accent"
      >
        {words.retry}
      </button>
    </div>
  );
}

// CLAUDE.md → Storefront → Empty state, at the checkout card's width
function EmptyCheckout({ words }: { words: CheckoutWords }) {
  return (
    <div className="mx-auto mt-4 flex max-w-[848px] flex-col items-center gap-4 rounded-2xl bg-card p-12 text-center md:mt-9">
      <span className="grid size-16 place-items-center rounded-full bg-cream">
        <HugeiconsIcon icon={ShoppingCart01Icon} size={28} strokeWidth={1.5} aria-hidden="true" />
      </span>
      <h1 className="text-sf-title font-semibold">{words.emptyTitle}</h1>
      <p className="max-w-80 text-muted">{words.emptyText}</p>
      <a
        href="/"
        className="mt-2 flex h-11 items-center rounded-sm bg-accent px-6 font-semibold transition-colors duration-150 hover:bg-brand hover:text-accent"
      >
        {words.continueShopping}
      </a>
    </div>
  );
}
