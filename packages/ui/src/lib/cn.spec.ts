import { describe, expect, it } from 'vitest';

import { cn } from './cn.js';

describe('cn', () => {
  it('lets the caller override a conflicting utility', () => {
    expect(cn('px-4 py-2', 'px-6')).toBe('py-2 px-6');
  });

  it('keeps a type-scale size and a text color together', () => {
    // plain tailwind-merge treats text-body as a color and drops it here
    expect(cn('text-body', 'text-ink')).toBe('text-body text-ink');
    expect(cn('text-label text-ink-3', 'text-caption')).toBe('text-ink-3 text-caption');
  });

  it('treats the custom radius and shadow tokens as their own groups', () => {
    expect(cn('rounded-control', 'rounded-card')).toBe('rounded-card');
    expect(cn('shadow-sm', 'shadow-ring')).toBe('shadow-ring');
  });

  it('drops falsy parts', () => {
    expect(cn('a', false, undefined, null, 'b')).toBe('a b');
  });
});
