import { createHash } from 'node:crypto';

import {
  type BookAnswer,
  type CourierAdapter,
  type CourierKeys,
  type CourierNotice,
  type CourierProblem,
  type FindAnswer,
  type ParcelRequest,
  type StatusAnswer,
} from './courier.js';
import { SteadfastAdapter } from './steadfast-adapter.js';

// A phone that makes the fake courier refuse the parcel, as Steadfast refuses a number it does not
// take, so the failed booking, the bell and "Book again" can be tried by hand and in the tests
export const FAKE_REFUSED_PHONE = '01700000000';

// Step 28a (decision 6): the courier of development, CI and the tests, like 27d's fake gateway. It
// keeps nothing and calls nobody: a booking's answer is worked out from the invoice, so the same
// invoice always gets the same consignment id and code (a retry is idempotent, as at Steadfast).
// Where a parcel goes next is told the way a courier tells it, by its webhook: post a Steadfast
// body to the account's webhook address (the guide's "Try it"); the poll gets nothing from it.
// It reads Steadfast's bodies, because with COURIER_MODE=fake it stands in for Steadfast. Refused
// in production (config.ts).
export class FakeCourier implements CourierAdapter {
  // Only for its pure readNotice: no call is ever made through it
  private readonly bodies = new SteadfastAdapter();

  book(keys: CourierKeys, parcel: ParcelRequest): Promise<BookAnswer> {
    const problem = fakeProblem(keys);
    if (problem !== null) return Promise.resolve({ kind: 'problem', problem });
    if (parcel.phone === FAKE_REFUSED_PHONE) {
      return Promise.resolve({
        kind: 'refused',
        detail: 'The recipient phone must be a working mobile number.',
      });
    }
    const hash = createHash('sha256').update(parcel.invoice).digest('hex');
    return Promise.resolve({
      kind: 'booked',
      parcel: {
        // Steadfast's ids are numbers; ten hex digits are at most 1,099,511,627,775
        consignmentId: String(Number.parseInt(hash.slice(0, 10), 16)),
        trackingCode: `FAKE${hash.slice(10, 20).toUpperCase()}`,
        // No page to show: the fake has no website
        trackingUrl: null,
        status: 'booked',
      },
    });
  }

  // It keeps no table, so no lost answer can be found: the caller books again, which gives the
  // same id and code anyway
  find(keys: CourierKeys): Promise<FindAnswer> {
    const problem = fakeProblem(keys);
    return Promise.resolve(problem === null ? { kind: 'none' } : { kind: 'problem', problem });
  }

  // It keeps nothing, so it cannot say where a parcel is: it answers as a courier that does not
  // answer, and the poll leaves the parcel where the webhook put it. An answer of "booked" here
  // would take a parcel back to booked after every webhook
  status(): Promise<StatusAnswer> {
    return Promise.resolve({ kind: 'problem', problem: 'unreachable' });
  }

  readNotice(body: unknown): CourierNotice {
    return this.bodies.readNotice(body);
  }

  test(keys: CourierKeys): Promise<CourierProblem | null> {
    return Promise.resolve(fakeProblem(keys));
  }
}

// Two API keys that make the fake courier answer like Steadfast on a bad day, as the fake
// gateway's two store ids do
function fakeProblem(keys: CourierKeys): CourierProblem | null {
  if (keys.apiKey === 'fake_rejected') return 'rejected';
  if (keys.apiKey === 'fake_unreachable') return 'unreachable';
  return null;
}
