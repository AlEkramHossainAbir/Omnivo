import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from './openapi.js';
import { routes } from './routes.js';

const document = buildOpenApiDocument(routes, { version: '0.0.0' });

describe('OpenAPI document', () => {
  it('has one operation per route, named after its place in the registry', () => {
    const ids = Object.values(document.paths).flatMap((methods) =>
      Object.values(methods).map((operation) => operation.operationId),
    );
    const expected = Object.entries(routes).flatMap(([tag, group]) =>
      Object.keys(group).map((name) => `${tag}.${name}`),
    );
    expect(ids.sort()).toEqual(expected.sort());
  });

  it('describes query parameters one by one, with their defaults', () => {
    const list = document.paths['/members']?.get;
    expect(list?.parameters.map((parameter) => parameter.name)).toEqual([
      'limit',
      'cursor',
      'sort',
    ]);
    expect(list?.parameters.every((parameter) => !parameter.required)).toBe(true);
    expect(list?.security).toEqual([{ bearer: [] }]);
  });

  it('marks public routes as needing no token and documents 204 without a body', () => {
    const logout = document.paths['/auth/logout']?.post;
    expect(logout?.security).toEqual([]);
    expect(logout?.responses['204']).toEqual({ description: 'No content' });
  });

  it('names the permission a route needs, for tools and for people', () => {
    const invite = document.paths['/invitations']?.post;
    expect(invite).toMatchObject({
      'x-permission': 'core.user.invite',
      description: 'Requires the `core.user.invite` permission.',
    });
    expect(document.paths['/roles']?.get).not.toHaveProperty('x-permission');
  });

  it('has no environment-specific server unless asked for one', () => {
    expect('servers' in document).toBe(false);
    expect(buildOpenApiDocument(routes, { version: '1', serverUrl: 'http://x' }).servers).toEqual([
      { url: 'http://x' },
    ]);
  });
});
