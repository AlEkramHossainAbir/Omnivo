import {
  ACCOUNT_PURPOSES,
  ACCOUNT_TYPES,
  createAccountInputSchema,
  createCustomFieldInputSchema,
  createUnitInputSchema,
  accountTypeFits,
  INDUSTRIES,
  STOCK_ACCOUNT_USES,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { type AccountTemplate, type CategoryTemplate, INDUSTRY_TEMPLATES } from './templates.js';

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

  it('chooses a ledger of the right type for every stock use (step 14)', () => {
    const typeOf = new Map(
      ACCOUNT_TYPES.flatMap((type) =>
        flatten(chart[type])
          .filter((node) => node.children === undefined && node.purpose === undefined)
          .map((node) => [node.code, type] as const),
      ),
    );
    const codes = INDUSTRY_TEMPLATES[industry].stockAccounts;
    for (const use of STOCK_ACCOUNT_USES) {
      const type = typeOf.get(codes[use]);
      expect(type, `${use} → ${codes[use]}`).toBeDefined();
      expect(accountTypeFits(use, type ?? ''), use).toBe(true);
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

function names(nodes: readonly CategoryTemplate[]): string[][] {
  return [
    nodes.map((node) => node.name.toLowerCase()),
    ...nodes.flatMap((node) => names(node.children ?? [])),
  ];
}

// The same reason as the charts: a mistake here would surface only in the worker, at a real
// workspace's setup. These are what the API itself would refuse.
describe.each(INDUSTRIES)('the %s catalog', (industry) => {
  const catalog = INDUSTRY_TEMPLATES[industry].catalog;

  it('has units the API accepts, each code once, with pieces and kilograms', () => {
    for (const unit of catalog.units) {
      expect(
        createUnitInputSchema.safeParse({ ...unit, ratio: unit.ratio ?? '' }).success,
        unit.code,
      ).toBe(true);
    }
    const codes = catalog.units.map((unit) => unit.code.toLowerCase());
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual(expect.arrayContaining(['pcs', 'kg']));
  });

  it('names sibling categories once', () => {
    for (const siblings of names(catalog.categories)) {
      expect(new Set(siblings).size, siblings.join(', ')).toBe(siblings.length);
    }
  });

  it('has custom fields the API accepts, each key once', () => {
    for (const field of catalog.customFields) {
      expect(
        createCustomFieldInputSchema.safeParse({
          entity: 'product',
          options: [],
          required: false,
          ...field,
        }).success,
        field.key,
      ).toBe(true);
    }
    const keys = catalog.customFields.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
