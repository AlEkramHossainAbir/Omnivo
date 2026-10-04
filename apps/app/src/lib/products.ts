import {
  CUSTOM_FIELD_COLUMN_PREFIX,
  type CustomFieldDefinition,
  PRODUCT_IMPORT_COLUMNS,
  type ProductCategory,
  type ProductVariantInput,
} from '@omnivo/contracts';
import { buildTree, flattenTree, type TreeNode } from '@omnivo/ui';

// Pure helpers of the product pages, tested on their own (products.spec.ts)

const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function categoryTree(categories: readonly ProductCategory[]): TreeNode<ProductCategory>[] {
  return buildTree(categories, {
    id: (category) => category.id,
    parentId: (category) => category.parentId,
    compare: (a, b) => byName.compare(a.name, b.name),
  });
}

function withoutBranch(
  nodes: readonly TreeNode<ProductCategory>[],
  id: string | undefined,
): TreeNode<ProductCategory>[] {
  return nodes.flatMap((node) =>
    node.id === id ? [] : [{ ...node, children: withoutBranch(node.children, id) }],
  );
}

// The categories in tree order, indented with em spaces for a native <select>. `moving` leaves out
// a category and everything under it: it cannot go inside itself (the API refuses that too).
export function categoryOptions(
  categories: readonly ProductCategory[],
  moving?: string,
): { value: string; label: string }[] {
  return flattenTree(withoutBranch(categoryTree(categories), moving)).map(({ node, depth }) => ({
    value: node.id,
    label: `${' '.repeat(depth)}${node.item.name}`,
  }));
}

// "Finished garments › T-shirts": where a product sits, for its row in the list
export function categoryPath(categories: readonly ProductCategory[], id: string | null): string {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const names: string[] = [];
  for (let current = id === null ? undefined : byId.get(id); current;) {
    names.unshift(current.name);
    // A broken parent chain (should never happen) must not loop forever
    if (names.length > 20) break;
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return names.join(' › ');
}

// "S, M, L,, m" → ['S', 'M', 'L']: what an option's values box holds. Empty parts and repeats (in
// any case) go, like the API's rule.
export function splitValues(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => {
      const folded = part.toLowerCase();
      if (part === '' || seen.has(folded)) return false;
      seen.add(folded);
      return true;
    });
}

// Every combination of the options' values, in order: Size × Colour = S-Navy, S-White, M-Navy …
export function combinations(options: readonly { values: readonly string[] }[]): string[][] {
  return options.reduce<string[][]>(
    (rows, option) => rows.flatMap((row) => option.values.map((value) => [...row, value])),
    [[]],
  );
}

// A field of one row of a react-hook-form field array: rowPath('units', 2, 'factor') →
// "units.2.factor". react-hook-form types it `units.${number}.factor`. The lint rule
// restrict-template-expressions wants String(index) in a template, which gives `${string}`, which
// react-hook-form does not accept. The one cast says only "this text was made from a number" —
// String(index) makes sure of it. Kept in this one place (CLAUDE.md rule 3), like journal.ts's
// linePath.
export function rowPath<A extends string, F extends string>(
  array: A,
  index: number,
  field: F,
): `${A}.${number}.${F}` {
  return `${array}.${String(index)}.${field}` as `${A}.${number}.${F}`;
}

// "0.914400" → "0.9144", "12.000000" → "12": a size as people write it
export function plainFactor(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

export function emptyVariant(optionValues: string[] = []): ProductVariantInput {
  return { id: null, sku: '', optionValues, barcode: '', salePrice: '', archived: false };
}

// The variants after the options changed: one per combination, in the options' order. A variant
// whose values still exist keeps everything (its id, SKU, barcode, price). The one variant of a
// product that was simple until now takes the first combination, so its id — and from step 13 its
// stock — carries over. Variants whose values no longer exist are left out.
export function syncVariants(
  options: readonly { values: readonly string[] }[],
  current: readonly ProductVariantInput[],
): ProductVariantInput[] {
  const key = (values: readonly string[]) => JSON.stringify(values);
  const byValues = new Map(current.map((variant) => [key(variant.optionValues), variant]));
  let former = current.find((variant) => variant.optionValues.length === 0);
  return combinations(options).map((values) => {
    const kept = byValues.get(key(values));
    if (kept) return kept;
    if (former) {
      const taken = { ...former, optionValues: values };
      former = undefined;
      return taken;
    }
    return emptyVariant(values);
  });
}

// One CSV cell: quoted when it holds a comma, a quote or a line break (RFC 4180)
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

// The import template: every column, the workspace's own fields at the end, and two example
// products — a simple one with packs, and one in two sizes (rows with the same code)
export function importTemplate(fields: readonly CustomFieldDefinition[]): string {
  const custom = fields
    .filter((field) => field.archivedAt === null)
    .map((field) => `${CUSTOM_FIELD_COLUMN_PREFIX}${field.key}`);
  const header = [...PRODUCT_IMPORT_COLUMNS, ...custom];
  // Record<string, …>: the header holds the custom columns too, which no example fills
  const example = (cells: Record<string, string>) =>
    header.map((column) => csvCell(cells[column] ?? ''));
  const rows = [
    header,
    example({
      name: 'Poly mailer bag 10x14',
      unit: 'pcs',
      sale_price: '6',
      pack1_unit: 'carton',
      pack1_factor: '500',
      purchase_unit: 'carton',
    }),
    example({
      code: 'ST-118',
      name: 'Pique polo shirt',
      category: 'Finished garments > Polo shirts',
      unit: 'pcs',
      option1_name: 'Size',
      option1_value: 'M',
      sale_price: '650',
    }),
    example({ code: 'ST-118', option1_value: 'L', sale_price: '650' }),
  ];
  // CRLF, and a BOM so Excel opens the Bangla in it as UTF-8
  return `\uFEFF${rows.map((row) => row.join(',')).join('\r\n')}\r\n`;
}
