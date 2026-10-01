import {
  ACCOUNT_PURPOSES,
  ACCOUNT_TYPES,
  createAccountInputSchema,
  INDUSTRIES,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { type AccountTemplate, INDUSTRY_TEMPLATES } from './templates.js';

function flatten(node: AccountTemplate): AccountTemplate[] {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

// The templates are data typed by hand. The database would refuse most mistakes, but only when a
// real workspace is set up — in the worker, after the owner's click. These checks catch them here.
describe.each(INDUSTRIES)('the %s chart', (industry) => {
  const chart = INDUSTRY_TEMPLATES[industry].chart;
  const all = ACCOUNT_TYPES.flatMap((type) => flatten(chart[type]));

  it('uses each code once, in the format the API accepts', () => {
    const codes = all.map((node) => node.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(createAccountInputSchema.shape.code.safeParse(code).success, code).toBe(true);
    }
  });

  it('has exactly one account for every purpose, and never on a group', () => {
    const purposes = all.flatMap((node) => (node.purpose === undefined ? [] : [node.purpose]));
    expect(purposes.toSorted()).toEqual([...ACCOUNT_PURPOSES].sort());
    for (const node of all) {
      if (node.purpose !== undefined) expect(node.children, node.code).toBeUndefined();
    }
  });

  it('starts each type with a group, and puts every code under its type digit', () => {
    ACCOUNT_TYPES.forEach((type, index) => {
      expect(chart[type].children).toBeDefined();
      for (const node of flatten(chart[type])) {
        expect(node.code.startsWith(String(index + 1)), node.code).toBe(true);
      }
    });
  });
});
