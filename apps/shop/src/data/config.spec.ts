import { describe, expect, it } from 'vitest';

import { shopConfigOf } from './config';

describe('shopConfigOf', () => {
  it('uses the mock without asking for an address', () => {
    expect(shopConfigOf('mock', undefined)).toEqual({ source: 'mock' });
    // An address left over from another setup does not switch the source
    expect(shopConfigOf('mock', 'http://api:3000')).toEqual({ source: 'mock' });
  });

  it('needs the API’s address for the API', () => {
    expect(() => shopConfigOf('api', undefined)).toThrow(/SHOP_API_URL/);
    // An empty value in a compose file ("SHOP_API_URL=") is no address either
    expect(() => shopConfigOf('api', '')).toThrow(/SHOP_API_URL/);
  });

  it('takes http and https, and drops the "/" at the end', () => {
    expect(shopConfigOf('api', 'http://api:3000/')).toEqual({
      source: 'api',
      apiUrl: 'http://api:3000',
    });
    expect(shopConfigOf('api', 'https://erp.example.com/api/')).toEqual({
      source: 'api',
      apiUrl: 'https://erp.example.com/api',
    });
  });

  it('refuses what is not an http address', () => {
    // "api:3000" is a valid URL with the scheme "api:", so only the scheme check catches it
    expect(() => shopConfigOf('api', 'api:3000')).toThrow(/http:\/\/ or https:\/\//);
    expect(() => shopConfigOf('api', 'not an address')).toThrow(/not an address/);
  });
});
