import { describe, expect, it } from 'vitest';

import { type ApiAnswer, createAnswerCache } from './answer-cache';

// A cache on a clock the test moves, and a loader that counts its calls
function setup(maxEntries = 10) {
  let time = 0;
  const cache = createAnswerCache({ ttlMs: 30_000, maxEntries, now: () => time });
  let loads = 0;
  const load = (answer: ApiAnswer = { status: 200, body: { n: loads + 1 } }) => {
    return () => {
      loads += 1;
      return Promise.resolve(answer);
    };
  };
  return {
    cache,
    load,
    loads: () => loads,
    wait: (ms: number) => {
      time += ms;
    },
  };
}

describe('createAnswerCache', () => {
  it('keeps an answer for 30 seconds, then asks again', async () => {
    const { cache, load, loads, wait } = setup();
    expect(await cache.read('a', load())).toEqual({ status: 200, body: { n: 1 } });
    wait(29_999);
    expect(await cache.read('a', load())).toEqual({ status: 200, body: { n: 1 } });
    expect(loads()).toBe(1);
    wait(1);
    expect(await cache.read('a', load())).toEqual({ status: 200, body: { n: 2 } });
    expect(loads()).toBe(2);
  });

  it('sends one request for callers that ask at the same time', async () => {
    const { cache, load, loads } = setup();
    const answers = await Promise.all([cache.read('a', load()), cache.read('a', load())]);
    expect(answers[0]).toBe(answers[1]);
    expect(loads()).toBe(1);
  });

  it('keeps a refusal, such as "no such product"', async () => {
    const { cache, load, loads } = setup();
    const missing = { status: 404, body: { code: 'not_found' } };
    await cache.read('a', load(missing));
    expect(await cache.read('a', load())).toEqual(missing);
    expect(loads()).toBe(1);
  });

  it('never keeps a failure', async () => {
    const { cache, load, loads } = setup();
    await cache.read('a', load({ status: 502, body: null }));
    await expect(cache.read('a', () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    // The rejected load has been forgotten too: the third read loads again (the second answer of
    // the counting loader, which the rejected one is not)
    expect(await cache.read('a', load())).toEqual({ status: 200, body: { n: 2 } });
    expect(loads()).toBe(2);
    expect(cache.size).toBe(1);
  });

  it('does not let an old failure remove a newer answer', async () => {
    const { cache, load, wait } = setup();
    let fail: (error: Error) => void = () => undefined;
    const slow = cache.read('a', () => new Promise<ApiAnswer>((_, reject) => (fail = reject)));
    // The slow answer has ended (its 30 seconds are over) before it fails; a new one comes in
    wait(30_000);
    await cache.read('a', load());
    fail(new Error('late'));
    await expect(slow).rejects.toThrow('late');
    expect(cache.size).toBe(1);
  });

  it('drops the oldest answer when it is full', async () => {
    const { cache, load, loads } = setup(2);
    await cache.read('a', load());
    await cache.read('b', load());
    await cache.read('c', load());
    expect(cache.size).toBe(2);
    // b is still kept; a was dropped and loads again
    await cache.read('b', load());
    expect(loads()).toBe(3);
    await cache.read('a', load());
    expect(loads()).toBe(4);
  });
});
