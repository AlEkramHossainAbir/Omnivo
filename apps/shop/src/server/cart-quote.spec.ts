import { problemSchema, shopCartQuoteSchema } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { mockSource } from '../data/mock/mock-source';
import type { ShopSource } from '../data/types';
import { answerCartQuote } from './cart-quote';

const STEVIA = 'lst-zero-cal-stevia-30-sachets';

function post(body: string): Request {
  return new Request('http://shop.test/api/cart/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

async function problemOf(response: Response) {
  expect(response.headers.get('Content-Type')).toBe('application/problem+json');
  return problemSchema.parse(await response.json());
}

describe('POST /api/cart/quote', () => {
  it('answers the quote, and no one may cache it', async () => {
    const response = await answerCartQuote(
      post(JSON.stringify({ lines: [{ listingId: STEVIA, quantity: 2 }] })),
      mockSource,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const quote = shopCartQuoteSchema.parse(await response.json());
    expect(quote.subtotal).toBe('240.0000');
  });

  it('refuses a body that is not JSON', async () => {
    const response = await answerCartQuote(post('{lines:'), mockSource);
    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe('malformed_request');
  });

  it('names each wrong field the way the ERP’s API does', async () => {
    const response = await answerCartQuote(
      post(
        JSON.stringify({
          lines: [
            { listingId: STEVIA, quantity: 1 },
            // A price is never taken from the browser: an unknown key is dropped, so this line is
            // wrong only for its quantity
            { listingId: 'lst-b', quantity: 100, price: '1' },
            { listingId: STEVIA, quantity: 1 },
          ],
        }),
      ),
      mockSource,
    );
    expect(response.status).toBe(400);
    const problem = await problemOf(response);
    expect(problem.code).toBe('invalid_input');
    expect(problem.fieldErrors).toEqual({
      'lines.1.quantity': ['too_large'],
      'lines.2.listingId': ['invalid_input'],
    });
  });

  it('hides a failing source behind internal_error', async () => {
    const down: ShopSource = {
      ...mockSource,
      quote: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:3000')),
    };
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const response = await answerCartQuote(post(JSON.stringify({ lines: [] })), down);
      expect(response.status).toBe(500);
      const problem = await problemOf(response);
      expect(problem.code).toBe('internal_error');
      // The API's address must never reach the shopper
      expect(JSON.stringify(problem)).not.toContain('10.0.0.5');
    } finally {
      console.error = quiet;
    }
  });
});
