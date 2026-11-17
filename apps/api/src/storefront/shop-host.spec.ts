import { describe, expect, it } from 'vitest';

import { subdomainOf } from './shop-host.js';

describe('subdomainOf', () => {
  it('takes the label in front of the base domain', () => {
    expect(subdomainOf('acme.omnivo.shop', 'omnivo.shop')).toBe('acme');
    expect(subdomainOf('nirvor-pharma.localhost', 'localhost')).toBe('nirvor-pharma');
  });

  it('drops the port, a trailing dot and the case', () => {
    expect(subdomainOf('acme.localhost:4331', 'localhost')).toBe('acme');
    expect(subdomainOf('ACME.Omnivo.Shop.', 'omnivo.shop')).toBe('acme');
    expect(subdomainOf(' acme.omnivo.shop ', 'omnivo.shop')).toBe('acme');
  });

  it('answers null for a host that is not one shop of ours', () => {
    expect(subdomainOf(undefined, 'omnivo.shop')).toBeNull();
    expect(subdomainOf('', 'omnivo.shop')).toBeNull();
    // The base domain itself, another domain, and one that only ends with the same letters
    expect(subdomainOf('omnivo.shop', 'omnivo.shop')).toBeNull();
    expect(subdomainOf('acme.example.com', 'omnivo.shop')).toBeNull();
    expect(subdomainOf('acme.evilomnivo.shop', 'omnivo.shop')).toBeNull();
    // Two labels, an empty one, and labels the database's check refuses
    expect(subdomainOf('a.b.omnivo.shop', 'omnivo.shop')).toBeNull();
    expect(subdomainOf('.omnivo.shop', 'omnivo.shop')).toBeNull();
    expect(subdomainOf('-acme.omnivo.shop', 'omnivo.shop')).toBeNull();
    expect(subdomainOf('acme_shop.omnivo.shop', 'omnivo.shop')).toBeNull();
    expect(subdomainOf(`${'a'.repeat(64)}.omnivo.shop`, 'omnivo.shop')).toBeNull();
  });
});
