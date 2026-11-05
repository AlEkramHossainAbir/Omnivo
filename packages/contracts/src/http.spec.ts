import { describe, expect, it } from 'vitest';

import { buildPath } from './http.js';
import { memberListQuerySchema } from './members.js';

describe('buildPath', () => {
  it('fills and encodes path parameters', () => {
    expect(buildPath('/branches/:id', { id: 'a/b c' })).toBe('/branches/a%2Fb%20c');
  });

  it('refuses to build a path with a missing parameter', () => {
    expect(() => buildPath('/branches/:id')).toThrow(/Missing path parameter "id"/);
  });
});

describe('page query', () => {
  it('turns querystring text into typed values with defaults', () => {
    expect(memberListQuerySchema.parse({ limit: '20' })).toEqual({ limit: 20, sort: 'name' });
    expect(memberListQuerySchema.parse({})).toEqual({ limit: 50, sort: 'name' });
  });

  it('caps the page size', () => {
    expect(memberListQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });
});
