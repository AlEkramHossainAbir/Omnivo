import type { ShopOrderConfirmed } from '@omnivo/contracts';

// Step 26c: the checkout tells the page that an order is confirmed with a DOM event, not a React
// prop. Two places confirm an order: the checkout island (Mobile Banking, no code) and the verify
// page's script (a right code, 26c.5). One "Order Confirmed" dialog listens on the document, so it
// does not care which of them sent it, and neither imports the dialog's code.
export const ORDER_CONFIRMED_EVENT = 'shop:order-confirmed';

export type OrderConfirmedEvent = CustomEvent<ShopOrderConfirmed>;

// Step 26c.5: TypeScript's list of the document's events gets this one, so a listener written
// `document.addEventListener(ORDER_CONFIRMED_EVENT, (event) => …)` gets an OrderConfirmedEvent,
// with a typed `detail`, and needs no cast. `as const` is not needed: a `const` string is its own
// literal type, which is what the map is looked up by
declare global {
  interface DocumentEventMap {
    [ORDER_CONFIRMED_EVENT]: OrderConfirmedEvent;
  }
}

export function announceOrderConfirmed(order: ShopOrderConfirmed): void {
  document.dispatchEvent(new CustomEvent(ORDER_CONFIRMED_EVENT, { detail: order }));
}
