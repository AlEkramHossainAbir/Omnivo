import type { ShopCartQuote } from '@omnivo/contracts';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { $cart, removeFromCart, type CartLine } from '../../lib/cart';
import { fetchCheckoutQuote } from './api';
import { quoteKey, quoteRequest } from './checkout';

// Step 26c: the checkout island's two hooks, the React side of what the cart drawer does by hand.

// The cart from the same nanostore the header and the drawer use, so a click on the stepper here
// changes the header's count at once. Without @nanostores/react: this hook is all the island
// needs from it, and useSyncExternalStore is what that package uses too.
// The server has no cart (it lives in this browser's localStorage), so the page is drawn with
// `null`, "not known yet", and the island shows "Getting today's prices…" until the browser
// takes over. An empty array would draw "Your cart is empty" for every shopper for a moment
function subscribe(onChange: () => void): () => void {
  // listen(), not subscribe(): React asks for the value itself and only wants to hear of changes.
  // The first listener also loads the stored cart (cart.ts → onMount)
  return $cart.listen(onChange);
}

const cartNow = (): CartLine[] => $cart.get();
const cartOnServer = (): null => null;

export function useCart(): CartLine[] | null {
  return useSyncExternalStore(subscribe, cartNow, cartOnServer);
}

// The same pause as the drawer: five quick clicks on "one more" make one request, not five
const QUOTE_DELAY = 250;

export type QuoteState =
  | { status: 'loading' }
  | { status: 'failed' }
  // `key` is the request this quote answers. `removed` counts the listings it said the shop no
  // longer sells, which have left the cart
  | { status: 'ready'; quote: ShopCartQuote; key: string; removed: number };

export function useCheckoutQuote(
  lines: CartLine[] | null,
  zoneId: string,
  couponCode: string | undefined,
) {
  const [state, setState] = useState<QuoteState>({ status: 'loading' });
  // Bumped by retry() and refresh() to run the effect again for the same cart
  const [attempt, setAttempt] = useState(0);
  // The request the last answer was for; null until the first one, so that one goes at once
  const answered = useRef<string | null>(null);

  useEffect(() => {
    if (lines === null || lines.length === 0) return;
    const request = quoteRequest(lines, zoneId, couponCode);
    // The quote on screen already answers this cart (a line the server dropped was just removed)
    if (answered.current === quoteKey(request)) return;

    const controller = new AbortController();
    const load = async (): Promise<void> => {
      // A failure stays on screen until a newer cart is being priced
      setState((current) => (current.status === 'failed' ? { status: 'loading' } : current));
      let quote: ShopCartQuote;
      try {
        quote = await fetchCheckoutQuote(request, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error(error);
        // Old prices could be wrong now, so they go, as in the drawer
        setState({ status: 'failed' });
        return;
      }
      // Listings the shop no longer sells leave the stored cart. The rest of the answer is still
      // right without them (they add nothing), so it answers the cart that is left, and removing
      // them asks for nothing again
      const gone = new Set(
        quote.lines.filter((line) => line.status === 'unavailable').map((line) => line.listingId),
      );
      const kept = lines.filter((line) => !gone.has(line.listingId));
      const key = quoteKey(quoteRequest(kept, zoneId, couponCode));
      answered.current = key;
      setState({ status: 'ready', quote, key, removed: gone.size });
      if (gone.size > 0) removeFromCart(gone);
    };
    // The first request goes at once; the rest wait for the clicks to stop
    const timer = window.setTimeout(
      () => {
        void load();
      },
      answered.current === null ? 0 : QUOTE_DELAY,
    );
    return () => {
      window.clearTimeout(timer);
      // An answer for a cart that no longer exists would be drawn over the newer one
      controller.abort();
    };
  }, [lines, zoneId, couponCode, attempt]);

  // "Try again" after a failure: the same cart, asked again at once
  const retry = useCallback(() => {
    answered.current = null;
    setState({ status: 'loading' });
    setAttempt((count) => count + 1);
  }, []);

  // After Confirm Order was refused because the cart changed: the answer on screen is old, so the
  // same request is asked again, and the old quote stays on screen (grey) until the new one comes
  const refresh = useCallback(() => {
    answered.current = null;
    // An empty key matches no cart, so the quote on screen counts as old until the answer
    setState((current) => (current.status === 'ready' ? { ...current, key: '' } : current));
    setAttempt((count) => count + 1);
  }, []);

  const key = lines === null ? null : quoteKey(quoteRequest(lines, zoneId, couponCode));
  // The quote on screen is for an older cart: its amounts are grey and Confirm Order waits
  const pricing = state.status === 'ready' && state.key !== key;
  return { state, pricing, retry, refresh };
}
