import { describe, expect, it } from 'vitest';

import { bn } from './bn.js';
import { en } from './en.js';
import { shopBn } from './shop/bn.js';
import { shopEn } from './shop/en.js';

// Step 26h.5: the type check makes sure bn.ts has every key of en.ts, but not that a sentence
// keeps its {{placeholders}}. A misspelt one ("{{maks}}" for "{{max}}") type-checks, and the
// screen then shows "{{maks}}" to every Bangla reader. These tests compare the two languages.

type Words = Readonly<Record<string, unknown>>;

// A block of keys, not a sentence (and not an array: the locales have none)
function isBlock(value: unknown): value is Words {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Every string in a locale, by its dotted key ("storefront.home.count")
function strings(messages: Words, prefix = ''): Map<string, string> {
  const found = new Map<string, string>();
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') found.set(path, value);
    else if (isBlock(value)) {
      for (const [inner, text] of strings(value, path)) found.set(inner, text);
    }
  }
  return found;
}

// The names inside {{ }}, sorted, each once. "{{- name}}" (not escaped) and "{{value, format}}"
// count as "name" and "value": the name is what the code passes, the rest is how it is shown.
// Once each: a sentence may use a name twice in one language and once in the other
function placeholders(text: string): string[] {
  const names = [...text.matchAll(/\{\{-?\s*([\w.]+)/g)].map((match) => match[1] ?? '');
  return [...new Set(names)].sort();
}

// The keys whose placeholders differ, as "key: en [a, b] / bn [a]"
function mismatches(english: Words, bangla: Words): string[] {
  const banglaStrings = strings(bangla);
  const wrong: string[] = [];
  for (const [key, text] of strings(english)) {
    const other = banglaStrings.get(key);
    // A key missing from bn.ts is the type check's job, not this test's
    if (other === undefined) continue;
    const a = placeholders(text);
    const b = placeholders(other);
    if (a.join(',') !== b.join(','))
      wrong.push(`${key}: en [${a.join(', ')}] / bn [${b.join(', ')}]`);
  }
  return wrong;
}

describe('placeholders', () => {
  it('finds each name once, with the unescaped and formatted forms', () => {
    expect(placeholders('{{count}} of {{max}} blocks')).toEqual(['count', 'max']);
    expect(placeholders('{{- name}} and {{ name }}')).toEqual(['name']);
    expect(placeholders('{{value, number}}')).toEqual(['value']);
    expect(placeholders('No placeholder')).toEqual([]);
  });
});

describe('the Bangla words keep the English placeholders', () => {
  it('in the app (en.ts, bn.ts)', () => {
    expect(mismatches(en, bn)).toEqual([]);
  });

  it('in the shop (shop/en.ts, shop/bn.ts)', () => {
    expect(mismatches(shopEn, shopBn)).toEqual([]);
  });

  it('notices a misspelt name', () => {
    expect(
      mismatches(
        { home: { count: '{{count}} of {{max}} blocks' } },
        { home: { count: '{{maks}}টার মধ্যে {{count}}টা ব্লক' } },
      ),
    ).toEqual(['home.count: en [count, max] / bn [count, maks]']);
  });
});
