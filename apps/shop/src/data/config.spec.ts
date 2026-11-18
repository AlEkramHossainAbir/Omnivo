import { describe, expect, it } from 'vitest';

import { shopConfigOf } from './config';

const KEY = 'dev-only-shop-key-change-me-0123456789abcdef';

describe('shopConfigOf', () => {
  it('uses the mock without asking for an address', () => {
    expect(shopConfigOf('mock', undefined, undefined)).toEqual({ source: 'mock' });
    // An address and a key left over from another setup do not switch the source
    expect(shopConfigOf('mock', 'http://api:3000', KEY)).toEqual({ source: 'mock' });
  });

  it('needs the API’s address for the API', () => {
    expect(() => shopConfigOf('api', undefined, KEY)).toThrow(/SHOP_API_URL/);
    // An empty value in a compose file ("SHOP_API_URL=") is no address either
    expect(() => shopConfigOf('api', '', KEY)).toThrow(/SHOP_API_URL/);
  });

  it('needs the shop’s key for the API', () => {
    expect(() => shopConfigOf('api', 'http://api:3000', undefined)).toThrow(/SHOP_API_KEY/);
    expect(() => shopConfigOf('api', 'http://api:3000', '')).toThrow(/SHOP_API_KEY/);
  });

  it('takes http and https, and drops the "/" at the end', () => {
    expect(shopConfigOf('api', 'http://api:3000/', KEY)).toEqual({
      source: 'api',
      apiUrl: 'http://api:3000',
      apiKey: KEY,
    });
    expect(shopConfigOf('api', 'https://erp.example.com/api/', KEY)).toEqual({
      source: 'api',
      apiUrl: 'https://erp.example.com/api',
      apiKey: KEY,
    });
  });

  it('refuses what is not an http address', () => {
    // "api:3000" is a valid URL with the scheme "api:", so only the scheme check catches it
    expect(() => shopConfigOf('api', 'api:3000', KEY)).toThrow(/http:\/\/ or https:\/\//);
    expect(() => shopConfigOf('api', 'not an address', KEY)).toThrow(/not an address/);
  });
});
