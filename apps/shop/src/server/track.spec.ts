import { describe, expect, it, vi } from 'vitest';

import type { ShopSource } from '../data/types';
import { mockDemoOrders } from '../data/mock/demo-orders';
import { createMockSource } from '../data/mock/mock-source';
import { createRateLimiter } from './rate-limit';
import { answerTrackForm } from './track';

// Step 26e: the /track form's POST

const SYLHET = { phone: '01786 120356', orderNo: 'w-000123' };
const HOME = '203.0.113.7';

// What a browser sends for the form: URLSearchParams sets the form's Content-Type itself
function post(body: Record<string, string>): Request {
  return new Request('http://shop.test/track', { method: 'POST', body: new URLSearchParams(body) });
}

// Each test has its own source and limiter, so no test spends another's tries
function context(source: ShopSource = createMockSource(undefined, mockDemoOrders)) {
  const limiter = createRateLimiter({ tries: 10, windowMs: 15 * 60 * 1000 });
  return {
    source,
    limiter,
    ask: (body: Record<string, string>, address = HOME) =>
      answerTrackForm(post(body), { source, limiter, address }),
  };
}

describe('the track form', () => {
  it('finds the order with the number and the phone, however they are typed', async () => {
    const answer = await context().ask(SYLHET);
    expect(answer.kind).toBe('found');
    if (answer.kind === 'found') expect(answer.tracking.orderNo).toBe('W-000123');
  });

  it('puts each box’s code under it, and gives the boxes back as they were typed', async () => {
    const answer = await context().ask({ phone: '0178', orderNo: 'SO-2026' });
    expect(answer).toEqual({
      kind: 'invalid',
      values: { phone: '0178', orderNo: 'SO-2026' },
      fieldErrors: { phone: ['shop_phone_format'], orderNo: ['shop_order_no_format'] },
    });
  });

  it('treats a body that is not a form as empty boxes', async () => {
    const { source, limiter } = context();
    const request = new Request('http://shop.test/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SYLHET),
    });
    const answer = await answerTrackForm(request, { source, limiter, address: HOME });
    expect(answer.kind).toBe('invalid');
    if (answer.kind === 'invalid') expect(answer.values).toEqual({ phone: '', orderNo: '' });
  });

  it('says not found for a wrong pair, and stops looking after ten', async () => {
    const { ask } = context();
    for (let miss = 0; miss < 10; miss += 1) {
      const answer = await ask({ phone: '01711284519', orderNo: 'W-000123' });
      expect(answer).toMatchObject({ kind: 'refused', code: 'shop_track_not_found' });
    }
    // The right pair now gets no answer either: nothing is looked up until the window ends
    expect(await ask(SYLHET)).toMatchObject({
      kind: 'refused',
      code: 'shop_track_too_many',
      params: { minutes: 15 },
      values: SYLHET,
    });
    // Another connection is not stopped
    expect((await ask(SYLHET, '198.51.100.4')).kind).toBe('found');
  });

  it('counts the misses of one IPv6 block together', async () => {
    const { ask } = context();
    for (let miss = 0; miss < 10; miss += 1) {
      await ask({ phone: '01711284519', orderNo: 'W-000123' }, `2001:db8:1:2::${String(miss)}`);
    }
    expect(await ask(SYLHET, '2001:db8:1:2::ff')).toMatchObject({ code: 'shop_track_too_many' });
  });

  it('never counts a look that found the order, or a box typed wrong', async () => {
    const { ask } = context();
    for (let look = 0; look < 20; look += 1) {
      await ask(SYLHET);
      await ask({ phone: '0178', orderNo: '' });
    }
    expect((await ask(SYLHET)).kind).toBe('found');
  });

  it('says try again when the source fails, and counts no miss', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken: ShopSource = {
      ...createMockSource(),
      track: () => Promise.reject(new Error('API down')),
    };
    const { ask } = context(broken);
    for (let attempt = 0; attempt < 11; attempt += 1) {
      expect(await ask(SYLHET)).toMatchObject({ kind: 'refused', code: 'internal_error' });
    }
    expect(error).toHaveBeenCalledWith('track order failed', expect.any(Error));
    error.mockRestore();
  });
});
