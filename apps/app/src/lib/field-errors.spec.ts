import type { SignUpInput } from '@omnivo/contracts';
import type { ErrorOption, Path } from 'react-hook-form';
import { describe, expect, it } from 'vitest';

import { ApiRequestError } from './api';
import { applyApiError } from './field-errors';

const FIELDS: Path<SignUpInput>[] = [
  'companyName',
  'workspaceSlug',
  'fullName',
  'email',
  'password',
];

// react-hook-form-এর setError-এর জায়গায় — কোন নামে কোন code বসল শুধু সেটা জমায়
function collect(error: unknown): Record<string, string | undefined> {
  const placed: Record<string, string | undefined> = {};
  applyApiError<SignUpInput>(error, FIELDS, (name: string, option: ErrorOption) => {
    placed[name] = option.message;
  });
  return placed;
}

function apiError(code: string, fieldErrors?: Record<string, string[]>): ApiRequestError {
  return new ApiRequestError({
    title: 'Conflict',
    status: 409,
    detail: 'x',
    code,
    ...(fieldErrors && { fieldErrors }),
  });
}

describe('applyApiError', () => {
  it('puts a field error under its field, as a code', () => {
    expect(collect(apiError('slug_taken', { workspaceSlug: ['slug_taken'] }))).toEqual({
      workspaceSlug: 'slug_taken',
    });
  });

  it('shows errors for fields the form does not have above the form', () => {
    expect(collect(apiError('invalid_input', { internalId: ['invalid_value'] }))).toEqual({
      'root.server': 'invalid_input',
    });
  });

  it('never shows an unknown code from the server as raw text', () => {
    expect(collect(apiError('brand_new_code', { email: ['brand_new_code'] }))).toEqual({
      email: 'invalid_value',
    });
    expect(collect(apiError('brand_new_code'))).toEqual({ 'root.server': 'unknown_error' });
  });

  it('treats anything that is not an API error as unknown', () => {
    expect(collect(new TypeError('boom'))).toEqual({ 'root.server': 'unknown_error' });
  });
});
