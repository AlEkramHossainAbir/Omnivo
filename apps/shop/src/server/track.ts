import { shopTrackRequestSchema, type ErrorCode, type ShopTracking } from '@omnivo/contracts';

import type { ShopSource, ShopTrackRefusal, SourceResult } from '../data/types';
import { fieldErrorsOf, parseOptions } from './problem';

// Step 26e: the /track form's POST, without Astro around it, like orders.ts. The page (26e.3)
// passes the request, the source, the limiter and the visitor's address, and draws what comes back.
// It is a plain HTML form that posts to its own page, not a JSON route: it works without
// JavaScript, and the phone stays in the request's body, never in an address that a browser's
// history, a proxy's log or a Referer header would keep (decision 3).

// What the shopper typed, to put back in the boxes when the page is drawn again. As it was typed
// ("01786 120356", "w-123"), not as the schema made it: the shopper should see their own words
export interface TrackFormValues {
  phone: string;
  orderNo: string;
}

// The codes under each box. Only the two boxes: the form has no other field to point at
export type TrackFieldErrors = Partial<Record<keyof TrackFormValues, ErrorCode[]>>;

// The refusals the page writes above the form. Each is an error code, so its words are
// t('errors.<code>') like any other error
export type TrackRefusal = ShopTrackRefusal | 'internal_error';

export type TrackFormAnswer =
  | { kind: 'found'; tracking: ShopTracking }
  | { kind: 'invalid'; values: TrackFormValues; fieldErrors: TrackFieldErrors }
  | {
      kind: 'refused';
      values: TrackFormValues;
      code: TrackRefusal;
      // shop_track_too_many: how long to wait, for its words ("try again in 12 minutes")
      params?: { minutes: number };
    };

// A box's value. `get` gives null for a box the form did not send and a File for a file input;
// both count as empty, so a hand-made request cannot make the page draw a File's name
function text(form: FormData, name: keyof TrackFormValues): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

// Step 27a: no limiter here any more. The limit is the source's (ShopSource.track): the API's in
// Redis, or the mock's in memory
interface TrackFormContext {
  source: ShopSource;
  // Astro.clientAddress: the visitor's IP (astro.config.mjs → security says where it comes from)
  address: string;
}

export async function answerTrackForm(
  request: Request,
  { source, address }: TrackFormContext,
): Promise<TrackFormAnswer> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // Not a form body (a script that posted JSON): the same as a form with empty boxes, which the
    // schema then refuses box by box
    form = new FormData();
  }
  const values = { phone: text(form, 'phone'), orderNo: text(form, 'orderNo') };

  // A box typed wrong ("0178", "SO-2026") is not a miss: nothing was looked up, so it tells a
  // guesser nothing and costs no try. Step 27a: this check now comes before the limit, because the
  // limit is the source's. A stopped guesser who types a broken number is told what to fix, which
  // tells them nothing about any order
  const parsed = shopTrackRequestSchema.safeParse(values, parseOptions);
  if (!parsed.success) {
    return { kind: 'invalid', values, fieldErrors: fieldErrorsOf(parsed.error) };
  }

  let result: SourceResult<ShopTracking, ShopTrackRefusal>;
  try {
    result = await source.track(parsed.data, address);
  } catch (error) {
    // The real source calls the API, which can be down. Logged with its details, like
    // sourceFailed in problem.ts; the shopper gets "try again", and no try is counted
    console.error('track order failed', error);
    return { kind: 'refused', values, code: 'internal_error' };
  }

  // Only a miss counts (decision 3), in the source. A shopper who checks their own order ten times
  // is never stopped, and many people behind one mobile operator's address share the misses, not
  // the looks
  if (result.ok) return { kind: 'found', tracking: result.value };
  if (result.code === 'shop_track_too_many') {
    // The source says how long; a missing number (an API that broke its word) still reads as "try
    // again later" rather than "in NaN minutes"
    const minutes = result.params?.minutes;
    return {
      kind: 'refused',
      values,
      code: result.code,
      params: { minutes: typeof minutes === 'number' ? minutes : 1 },
    };
  }
  return { kind: 'refused', values, code: result.code };
}
