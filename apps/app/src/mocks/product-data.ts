import {
  type CustomFieldDefinition,
  customFieldsInputSchema,
  type ErrorCode,
  formatDocumentNumber,
  isErrorCode,
  type Product,
  type ProductCategory,
  type ProductImport,
  type ProductImportDetail,
  type ProductImportError,
  type ProductInput,
  type ProductSort,
  type ProductStatus,
  type ProductSummary,
  sameFactor,
  standardFactor,
  type Unit,
  variantSku,
} from '@omnivo/contracts';

import { MockProblem } from './mock';

// The mock's products, units, categories, custom fields and imports. A shorter copy of the API's
// templates (apps/api/src/setup/templates.ts) — the mock cannot import server code — and the same
// rules as the API where the UI shows their errors.

export interface MockImport extends ProductImportDetail {
  // When the pretend worker finishes it, and the uploaded text it reads
  readyAt: number;
  text: string | null;
}

export interface MockCatalog {
  units: Unit[];
  categories: ProductCategory[];
  fields: CustomFieldDefinition[];
  products: Product[];
  imports: MockImport[];
  // The last product code given (P-00042)
  lastCode: number;
}

function now(): string {
  return new Date().toISOString();
}

function unit(
  code: string,
  name: string,
  dimension: string,
  ratio: string | null,
  decimals = 0,
): Unit {
  return {
    id: crypto.randomUUID(),
    code,
    name,
    dimension,
    ratio,
    decimals,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
}

function field(
  key: string,
  label: string,
  type: string,
  options: string[] = [],
  required = false,
): CustomFieldDefinition {
  return {
    id: crypto.randomUUID(),
    entity: 'product',
    key,
    label,
    type,
    options,
    required,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
}

const COMMON_UNITS = () => [
  unit('pcs', 'Pieces', 'count', '1.000000'),
  unit('dozen', 'Dozen', 'count', '12.000000'),
  unit('kg', 'Kilogram', 'weight', '1.000000', 3),
  unit('g', 'Gram', 'weight', '0.001000'),
  unit('m', 'Metre', 'length', '1.000000', 2),
  unit('l', 'Litre', 'volume', '1.000000', 3),
  unit('box', 'Box', 'count', null),
  unit('carton', 'Carton', 'count', null),
];

// Categories from a [name, children] list; returns them flat with parent ids, like the API
function categoriesOf(tree: readonly (readonly [string, readonly string[]])[]): ProductCategory[] {
  return tree.flatMap(([name, children]) => {
    const parent: ProductCategory = {
      id: crypto.randomUUID(),
      parentId: null,
      name,
      productCount: 0,
      version: 1,
      updatedAt: now(),
    };
    return [
      parent,
      ...children.map((child) => ({
        ...parent,
        id: crypto.randomUUID(),
        parentId: parent.id,
        name: child,
      })),
    ];
  });
}

export function emptyCatalog(): MockCatalog {
  return { units: [], categories: [], fields: [], products: [], imports: [], lastCode: 0 };
}

// What the setup job gives a new workspace (no products: those are the company's own)
export function startingCatalog(industry: string): MockCatalog {
  const pharma = industry === 'pharma';
  return {
    ...emptyCatalog(),
    units: pharma
      ? [
          ...COMMON_UNITS(),
          unit('strip', 'Strip', 'count', null),
          unit('bottle', 'Bottle', 'count', null),
        ]
      : [
          ...COMMON_UNITS(),
          unit('yard', 'Yard', 'length', '0.914400', 2),
          unit('gross', 'Gross', 'count', '144.000000'),
          unit('cone', 'Cone', 'count', null),
        ],
    categories: pharma
      ? categoriesOf([
          ['Finished products', ['Tablets', 'Capsules', 'Syrups and suspensions']],
          ['Raw materials', ['Active ingredients (API)', 'Excipients']],
          ['Packing materials', []],
        ])
      : categoriesOf([
          ['Fabrics', ['Knit', 'Woven']],
          ['Trims and accessories', ['Buttons', 'Labels', 'Sewing thread']],
          ['Packing materials', []],
          ['Finished garments', ['T-shirts', 'Polo shirts', 'Trousers', 'Jackets']],
        ]),
    fields: pharma
      ? [
          field('generic_name', 'Generic name', 'text', [], true),
          field('strength', 'Strength', 'text'),
          field('dosage_form', 'Dosage form', 'select', [
            'Tablet',
            'Capsule',
            'Syrup',
            'Injection',
          ]),
        ]
      : [
          field('buyer', 'Buyer', 'text'),
          field('composition', 'Fabric composition', 'text'),
          field('gsm', 'GSM', 'number'),
        ],
  };
}

function codeAt(sequence: number): string {
  return formatDocumentNumber({ prefix: 'P', yearStyle: 'none', padding: 5 }, '', sequence);
}

function variantOf(
  sku: string,
  optionValues: string[],
  salePrice: string | null,
  barcode: string | null = null,
) {
  return { id: crypto.randomUUID(), sku, optionValues, barcode, salePrice, archivedAt: null };
}

// A product as the API would return it, from a short description
function product(
  catalog: MockCatalog,
  parts: {
    code: string;
    name: string;
    category: string;
    base: string;
    price: string | null;
    options?: { name: string; values: string[] }[];
    barcode?: string;
    packs?: [string, string][];
    customFields?: Record<string, string>;
    updatedMinutesAgo?: number;
  },
): Product {
  const categoryId =
    catalog.categories.find((category) => category.name === parts.category)?.id ?? null;
  const unitId = (code: string) => catalog.units.find((unit) => unit.code === code)?.id ?? '';
  const options = parts.options ?? [];
  const combos = options.reduce<string[][]>(
    (rows, option) => rows.flatMap((row) => option.values.map((value) => [...row, value])),
    [[]],
  );
  return {
    id: crypto.randomUUID(),
    code: parts.code,
    name: parts.name,
    type: 'goods',
    categoryId,
    description: null,
    baseUnitId: unitId(parts.base),
    salesUnitId: null,
    purchaseUnitId: parts.packs?.[0] ? unitId(parts.packs[0][0]) : null,
    tracking: 'none',
    hasExpiry: false,
    options,
    variants: combos.map((values) =>
      variantOf(
        variantSku(parts.code, values),
        values,
        parts.price,
        values.length === 0 ? (parts.barcode ?? null) : null,
      ),
    ),
    units: (parts.packs ?? []).map(([code, factor]) => ({
      unitId: unitId(code),
      factor,
      barcode: null,
    })),
    customFields: parts.customFields ?? {},
    archivedAt: null,
    version: 1,
    updatedAt: new Date(Date.now() - (parts.updatedMinutesAgo ?? 60) * 60_000).toISOString(),
  };
}

const GARMENTS = ['T-shirt', 'Polo shirt', 'Hoodie', 'Trouser', 'Jacket', 'Sweatshirt'] as const;
const CATEGORY_OF = {
  'T-shirt': 'T-shirts',
  'Polo shirt': 'Polo shirts',
  Hoodie: 'Jackets',
  Trouser: 'Trousers',
  Jacket: 'Jackets',
  Sweatshirt: 'T-shirts',
} satisfies Record<(typeof GARMENTS)[number], string>;
const FITS = ['Regular fit', 'Slim fit', 'Oversized', 'Kids'] as const;
const BUYERS = ['H&M', 'Primark', 'Zara', 'C&A', 'Walmart'] as const;

// The garments workspace: a few real-looking products, then 10,000 styles — enough to see the
// list stay smooth (virtualized rows, 50 at a time from the server)
export function garmentsCatalog(): MockCatalog {
  const catalog = startingCatalog('garments');
  const named = [
    product(catalog, {
      code: 'ST-118',
      name: 'Pique polo shirt',
      category: 'Polo shirts',
      base: 'pcs',
      price: '650.0000',
      options: [
        { name: 'Size', values: ['M', 'L', 'XL'] },
        { name: 'Colour', values: ['Navy blue', 'White'] },
      ],
      packs: [['dozen', '12.000000']],
      customFields: { buyer: 'H&M', gsm: '220' },
      updatedMinutesAgo: 5,
    }),
    product(catalog, {
      code: 'P-00001',
      name: 'Basic crew-neck T-shirt',
      category: 'T-shirts',
      base: 'pcs',
      price: '320.0000',
      barcode: '8941100500118',
      customFields: { buyer: 'Primark', gsm: '160' },
    }),
    product(catalog, {
      code: 'P-00002',
      name: 'Single jersey 180 GSM',
      category: 'Knit',
      base: 'm',
      price: null,
      packs: [['yard', '0.914400']],
      customFields: { composition: '100% cotton', gsm: '180' },
    }),
    product(catalog, {
      code: 'P-00003',
      name: 'Shirt buttons 4-hole 18L',
      category: 'Buttons',
      base: 'pcs',
      price: null,
      packs: [['gross', '144.000000']],
    }),
    product(catalog, {
      code: 'P-00004',
      name: 'Poly mailer bag 10x14',
      category: 'Packing materials',
      base: 'pcs',
      price: '6.0000',
      packs: [['carton', '500.000000']],
    }),
    // Step 13: a machine tracked by its serial plate, for the serial number screens
    {
      ...product(catalog, {
        code: 'P-00005',
        name: 'Juki DDL-8000A lockstitch machine',
        category: 'Finished garments',
        base: 'pcs',
        price: null,
      }),
      categoryId: null,
      tracking: 'serial',
    },
  ];
  const generated = Array.from({ length: 10_000 }, (_, index) => {
    const garment = GARMENTS[index % GARMENTS.length] ?? 'T-shirt';
    const fit = FITS[index % FITS.length] ?? 'Regular fit';
    const style = 20_000 + index;
    return product(catalog, {
      code: `ST-${String(style)}`,
      name: `${fit} ${garment.toLowerCase()} ${String(style)}`,
      category: CATEGORY_OF[garment],
      base: 'pcs',
      price: `${String(300 + (index % 40) * 25)}.0000`,
      ...(index % 4 === 0 && { options: [{ name: 'Size', values: ['S', 'M', 'L', 'XL'] }] }),
      customFields: { buyer: BUYERS[index % BUYERS.length] ?? 'H&M' },
      updatedMinutesAgo: 60 + index,
    });
  });
  return { ...catalog, products: [...named, ...generated], lastCode: 5 };
}

export function pharmaCatalog(): MockCatalog {
  const catalog = startingCatalog('pharma');
  const napa = product(catalog, {
    code: 'P-00001',
    name: 'Napa 500 mg',
    category: 'Tablets',
    base: 'pcs',
    price: '1.2000',
    barcode: '8941100500200',
    packs: [
      ['strip', '10.000000'],
      ['box', '100.000000'],
    ],
    customFields: { generic_name: 'Paracetamol', strength: '500 mg', dosage_form: 'Tablet' },
  });
  return {
    ...catalog,
    products: [{ ...napa, tracking: 'batch', hasExpiry: true }],
    lastCode: 1,
  };
}

// --- The list -----------------------------------------------------------------------------------

export function productSummaryOf(item: Product): ProductSummary {
  const active = item.variants.filter((variant) => variant.archivedAt === null);
  const prices = active.flatMap((variant) =>
    variant.salePrice === null ? [] : [Number(variant.salePrice)],
  );
  const money = (value: number) => value.toFixed(4);
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    type: item.type,
    categoryId: item.categoryId,
    baseUnitId: item.baseUnitId,
    tracking: item.tracking,
    hasVariants: item.options.length > 0,
    variantCount: active.length,
    minPrice: prices.length === 0 ? null : money(Math.min(...prices)),
    maxPrice: prices.length === 0 ? null : money(Math.max(...prices)),
    archivedAt: item.archivedAt,
    updatedAt: item.updatedAt,
  };
}

// The API's filters and orders, on an array. The cursor is an offset, like the mock's other lists.
export function listProducts(
  catalog: MockCatalog,
  query: {
    search?: string | undefined;
    categoryId?: string | undefined;
    status: ProductStatus;
    sort: ProductSort;
  },
) {
  const search = query.search?.toLowerCase() ?? '';
  const inside = new Set<string>();
  if (query.categoryId !== undefined) {
    inside.add(query.categoryId);
    for (let grew = true; grew;) {
      grew = false;
      for (const category of catalog.categories) {
        if (
          category.parentId !== null &&
          inside.has(category.parentId) &&
          !inside.has(category.id)
        ) {
          inside.add(category.id);
          grew = true;
        }
      }
    }
  }
  const found = catalog.products.filter(
    (item) =>
      (query.status === 'archived') === (item.archivedAt !== null) &&
      (query.categoryId === undefined ||
        (item.categoryId !== null && inside.has(item.categoryId))) &&
      (search === '' ||
        item.name.toLowerCase().includes(search) ||
        item.code.toLowerCase().includes(search) ||
        item.variants.some(
          (variant) =>
            variant.sku.toLowerCase().includes(search) || variant.barcode === query.search,
        )),
  );
  const by = {
    name: (a: Product, b: Product) => a.name.localeCompare(b.name),
    '-name': (a: Product, b: Product) => b.name.localeCompare(a.name),
    code: (a: Product, b: Product) => a.code.localeCompare(b.code),
    '-code': (a: Product, b: Product) => b.code.localeCompare(a.code),
    '-updated': (a: Product, b: Product) => b.updatedAt.localeCompare(a.updatedAt),
  };
  return found.sort(by[query.sort]);
}

// --- Saving, with the API's rules ---------------------------------------------------------------

function problem(status: number, path: string, code: ErrorCode): MockProblem {
  return new MockProblem(status, status === 409 ? code : 'invalid_input', { [path]: [code] });
}

export function saveProduct(
  catalog: MockCatalog,
  input: ProductInput,
  existing?: Product,
): Product {
  const unitOf = (id: string) => catalog.units.find((unit) => unit.id === id);
  const base = unitOf(input.baseUnitId);
  if (!base) throw problem(400, 'baseUnitId', 'product_unit_invalid');
  input.units.forEach((pack, index) => {
    const packUnit = unitOf(pack.unitId);
    if (!packUnit) throw problem(400, `units.${String(index)}.unitId`, 'product_unit_invalid');
    const standard = standardFactor(packUnit, base);
    if (standard !== null && !sameFactor(standard, pack.factor)) {
      throw problem(400, `units.${String(index)}.factor`, 'product_factor_standard');
    }
  });
  if (
    input.categoryId !== null &&
    !catalog.categories.some((category) => category.id === input.categoryId)
  ) {
    throw problem(400, 'categoryId', 'product_category_invalid');
  }
  const active = catalog.fields.filter((definition) => definition.archivedAt === null);
  const fields = customFieldsInputSchema(active).safeParse(input.customFields);
  if (!fields.success) {
    const fieldErrors: Record<string, ErrorCode[]> = {};
    for (const issue of fields.error.issues) {
      const path = ['customFields', ...issue.path.map(String)].join('.');
      (fieldErrors[path] ??= []).push(isErrorCode(issue.message) ? issue.message : 'invalid_value');
    }
    throw new MockProblem(400, 'invalid_input', fieldErrors);
  }

  const others = catalog.products.filter((item) => item.id !== existing?.id);
  let code = input.code ?? existing?.code;
  if (code === undefined) {
    catalog.lastCode += 1;
    code = codeAt(catalog.lastCode);
  }
  const folded = code.toLowerCase();
  if (others.some((item) => item.code.toLowerCase() === folded)) {
    throw problem(409, 'code', 'product_code_taken');
  }
  const skus = new Set(
    others.flatMap((item) => item.variants.map((variant) => variant.sku.toLowerCase())),
  );
  const barcodes = new Set(
    others.flatMap((item) => [
      ...item.variants.flatMap((variant) => (variant.barcode === null ? [] : [variant.barcode])),
      ...item.units.flatMap((pack) => (pack.barcode === null ? [] : [pack.barcode])),
    ]),
  );
  const known = new Map(existing?.variants.map((variant) => [variant.id, variant]));
  const variants = input.variants.map((variant, index) => {
    const sku = variant.sku ?? variantSku(code, variant.optionValues);
    if (skus.has(sku.toLowerCase()))
      throw problem(409, `variants.${String(index)}.sku`, 'product_sku_taken');
    if (variant.barcode !== null && barcodes.has(variant.barcode)) {
      throw problem(409, `variants.${String(index)}.barcode`, 'barcode_taken');
    }
    const before = variant.id === null ? undefined : known.get(variant.id);
    if (variant.id !== null && !before)
      throw problem(400, `variants.${String(index)}.id`, 'product_variant_unknown');
    return {
      id: before?.id ?? crypto.randomUUID(),
      sku,
      optionValues: variant.optionValues,
      barcode: variant.barcode,
      salePrice: variant.salePrice === null ? null : Number(variant.salePrice).toFixed(4),
      archivedAt: variant.archived ? (before?.archivedAt ?? now()) : null,
    };
  });
  // Archived fields keep their values: the form never sends them
  const kept = Object.fromEntries(
    Object.entries(existing?.customFields ?? {}).filter(
      ([key]) => !active.some((definition) => definition.key === key),
    ),
  );
  return {
    id: existing?.id ?? crypto.randomUUID(),
    code,
    name: input.name,
    type: input.type,
    categoryId: input.categoryId,
    description: input.description,
    baseUnitId: input.baseUnitId,
    salesUnitId: input.salesUnitId === input.baseUnitId ? null : input.salesUnitId,
    purchaseUnitId: input.purchaseUnitId === input.baseUnitId ? null : input.purchaseUnitId,
    tracking: input.tracking,
    hasExpiry: input.hasExpiry,
    options: input.options,
    variants,
    units: input.units.map((pack) => ({ ...pack, factor: Number(pack.factor).toFixed(6) })),
    customFields: { ...kept, ...fields.data },
    archivedAt: existing?.archivedAt ?? null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
  };
}

export function findProduct(catalog: MockCatalog, id: string): Product {
  const found = catalog.products.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// --- Imports: a pretend worker ------------------------------------------------------------------

// How long the pretend import takes — long enough to see "Importing"
export const IMPORT_DELAY_MS = 1_500;

// A naive reading of the CSV (no quoted commas): enough for the mock. Rows need a name and a known
// unit; the rest is left out. All or nothing, like the real worker.
function readImport(
  catalog: MockCatalog,
  text: string,
): { errors: ProductImportError[]; rows: { name: string; unitId: string; price: string }[] } {
  const [head = '', ...lines] = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = head.split(',').map((cell) => cell.trim().toLowerCase());
  const errors: ProductImportError[] = [];
  for (const column of ['name', 'unit']) {
    if (!header.includes(column))
      errors.push({ row: 1, column, code: 'import_column_missing', params: { column } });
  }
  if (errors.length > 0) return { errors, rows: [] };
  const rows = lines.flatMap((line, index) => {
    if (line.trim() === '') return [];
    const cells = line.split(',');
    const cell = (column: string) => (cells[header.indexOf(column)] ?? '').trim();
    const row = index + 2;
    const unitId = catalog.units.find(
      (unit) => unit.code.toLowerCase() === cell('unit').toLowerCase(),
    )?.id;
    if (cell('name').length < 2)
      errors.push({ row, column: 'name', code: 'product_name_required' });
    if (!unitId)
      errors.push({
        row,
        column: 'unit',
        code: 'import_unit_unknown',
        params: { value: cell('unit') },
      });
    return unitId ? [{ name: cell('name'), unitId, price: cell('sale_price') }] : [];
  });
  if (rows.length === 0 && errors.length === 0)
    errors.push({ row: null, column: null, code: 'import_empty' });
  return { errors, rows };
}

export function settleImports(
  catalog: MockCatalog,
  notify: (type: 'import.done' | 'import.failed', params: { file: string; count: number }) => void,
): void {
  for (const item of catalog.imports) {
    if (item.status !== 'queued' || Date.now() < item.readyAt) continue;
    const { errors, rows } = readImport(catalog, item.text ?? '');
    const lineCount = rows.length + new Set(errors.map((error) => error.row)).size;
    if (errors.length > 0) {
      Object.assign(item, {
        status: 'failed',
        rowCount: lineCount,
        errorCount: errors.length,
        errors,
        finishedAt: now(),
      });
      notify('import.failed', { file: item.fileName, count: errors.length });
      continue;
    }
    for (const row of rows) {
      catalog.lastCode += 1;
      const code = codeAt(catalog.lastCode);
      catalog.products.push({
        ...product(catalog, {
          code,
          name: row.name,
          category: '',
          base: 'pcs',
          price: row.price === '' ? null : Number(row.price).toFixed(4),
        }),
        baseUnitId: row.unitId,
        updatedAt: now(),
      });
    }
    Object.assign(item, {
      status: 'done',
      rowCount: rows.length,
      productCount: rows.length,
      finishedAt: now(),
    });
    notify('import.done', { file: item.fileName, count: rows.length });
  }
}

// What the API sends of an import: the pretend worker's own fields left out
export function toImport(item: MockImport): ProductImport {
  return {
    id: item.id,
    fileName: item.fileName,
    sizeBytes: item.sizeBytes,
    status: item.status,
    rowCount: item.rowCount,
    productCount: item.productCount,
    errorCount: item.errorCount,
    requestedBy: item.requestedBy,
    createdAt: item.createdAt,
    finishedAt: item.finishedAt,
  };
}
