import type { ShopOrder, ShopOrderStatus } from '@omnivo/contracts';

// Step 26c: the steps of an order's status timeline (CLAUDE.md → Track order: done, current and
// later dots). /order/<no> draws it now and 26d's /track draws the same one, so the rules live
// here, apart from the markup, and are tested once.

export type TimelineState = 'done' | 'current' | 'later';

export interface TimelineStep {
  status: ShopOrderStatus;
  // When the order reached this step (ISO), or null for a step still ahead
  at: string | null;
  state: TimelineState;
}

// The road an order normally takes. Cancelled and returned leave it, so they are not on it
const ROAD: readonly ShopOrderStatus[] = ['pending', 'confirmed', 'packed', 'shipped', 'delivered'];

export function orderTimeline(order: Pick<ShopOrder, 'status' | 'history'>): TimelineStep[] {
  // The last time each status was reached. An order may pass a status twice (a shop that moves it
  // back by mistake); the newest date is the true one
  const reached = new Map<ShopOrderStatus, string>();
  for (const step of order.history) reached.set(step.status, step.at);

  if (order.status === 'cancelled' || order.status === 'returned') {
    // Only what happened, in its order, ending on the cancel or the return. Steps that will never
    // come are not drawn as "later": that would promise a delivery
    return order.history.map((step, index) => ({
      status: step.status,
      at: step.at,
      state: index === order.history.length - 1 ? 'current' : 'done',
    }));
  }

  const now = ROAD.indexOf(order.status);
  return ROAD.map((status, index) => ({
    status,
    // A step behind the current one without a date (a shop that jumped from confirmed to shipped)
    // is still done: the order is past it. It just has no date to show
    at: index <= now ? (reached.get(status) ?? null) : null,
    // Delivered is the end of the road: done, not "current", since nothing more will happen
    state:
      index < now || (index === now && status === 'delivered')
        ? 'done'
        : index === now
          ? 'current'
          : 'later',
  }));
}
