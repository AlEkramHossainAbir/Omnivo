import {
  CATEGORY_PATH_SEPARATOR,
  contractErrorMap,
  CUSTOM_FIELD_COLUMN_PREFIX,
  type CustomFieldDefinition,
  customFieldsInputSchema,
  type ErrorCode,
  isErrorCode,
  PRODUCT_IMPORT_COLUMNS,
  PRODUCT_IMPORT_MAX_ROWS,
  PRODUCT_IMPORT_REQUIRED_COLUMNS,
  type ProductImportError,
  type ProductInput,
  productInputSchema,
  type TrackingMode,
} from '@omnivo/contracts';
import { CsvError, parse } from 'csv-parse/sync';

// The CSV half of an import, without the database: bytes in, product inputs (or what is wrong)
// out. Pure, so every rule is tested on its own (csv.spec.ts) without containers.

interface ImportUnit {
  id: string;
  code: string;
}

// What the file is read against: the workspace's active units and fields, and what a blank
// tracking cell means (the form's default for the business type)
export interface ImportLookups {
  units: readonly ImportUnit[];
  fields: readonly Pick<CustomFieldDefinition, 'key' | 'type' | 'options' | 'required'>[];
  defaultTracking: { tracking: TrackingMode; hasExpiry: boolean };
}

// One product of the file: its checked input, the rows it came from (the first holds the product's
// own cells, each row is one variant), and its category as a path still to be found or made
export interface ImportedProduct {
  input: ProductInput;
  rows: number[];
  categoryPath: string[] | null;
}

export interface ReadFile {
  products: ImportedProduct[];
  errors: ProductImportError[];
  rowCount: number;
}

type Cells = Record<string, string>;

function fileError(code: ErrorCode, params?: Record<string, string | number>): ProductImportError {
  return { row: null, column: null, code, ...(params && { params }) };
}

// Bytes → text. Excel's "CSV UTF-8" starts with a byte order mark; its plain "CSV" on Windows is
// not UTF-8 at all, and a Bangla name would come out as question marks. fatal: true refuses such a
// file instead of importing broken names.
function decode(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

// The cells of the columns that describe the product, not one variant: in a product's later rows
// they are empty or the same as in its first row
const PRODUCT_COLUMNS = new Set<string>([
  'code',
  'name',
  'type',
  'category',
  'unit',
  'option1_name',
  'option2_name',
  'option3_name',
  'sales_unit',
  'purchase_unit',
  'pack1_unit',
  'pack1_factor',
  'pack1_barcode',
  'pack2_unit',
  'pack2_factor',
  'pack2_barcode',
  'tracking',
  'expiry',
  'description',
]);

const OPTION_COLUMNS = [1, 2, 3] as const;
const PACK_COLUMNS = [1, 2] as const;

// The column a contract path belongs to, for a product built from `rows`: "units.1.factor" →
// pack2_factor on the first row; "variants.3.sku" → sku on the fourth row
export function columnOf(path: readonly (string | number)[], rows: readonly number[]) {
  const first = rows[0] ?? null;
  const [head, index, field] = path;
  const at = (row: number | null, column: string | null) => ({ row, column });
  switch (head) {
    case 'baseUnitId':
      return at(first, 'unit');
    case 'salesUnitId':
      return at(first, 'sales_unit');
    case 'purchaseUnitId':
      return at(first, 'purchase_unit');
    case 'hasExpiry':
      return at(first, 'expiry');
    case 'categoryId':
      return at(first, 'category');
    case 'code':
    case 'name':
    case 'type':
    case 'tracking':
    case 'description':
      return at(first, head);
    case 'options':
      return typeof index === 'number'
        ? at(
            first,
            field === 'name'
              ? `option${String(index + 1)}_name`
              : `option${String(index + 1)}_value`,
          )
        : at(first, 'option1_name');
    case 'units':
      return typeof index === 'number'
        ? at(
            first,
            `pack${String(index + 1)}_${field === 'factor' ? 'factor' : field === 'barcode' ? 'barcode' : 'unit'}`,
          )
        : at(first, 'pack1_unit');
    case 'customFields':
      return at(first, typeof index === 'string' ? `${CUSTOM_FIELD_COLUMN_PREFIX}${index}` : null);
    case 'variants': {
      if (typeof index !== 'number') return at(rows[1] ?? first, 'option1_value');
      const row = rows[index] ?? first;
      const column =
        field === 'sku'
          ? 'sku'
          : field === 'barcode'
            ? 'barcode'
            : field === 'salePrice'
              ? 'sale_price'
              : 'option1_value';
      return at(row, column);
    }
    default:
      return at(first, null);
  }
}

const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);

export function readProductsCsv(bytes: Uint8Array, lookups: ImportLookups): ReadFile {
  const text = decode(bytes);
  if (text === null) return { products: [], errors: [fileError('import_encoding')], rowCount: 0 };

  let records: string[][];
  try {
    // relax_column_count: Excel leaves trailing empty cells out of short rows. bom: drop the BOM.
    records = parse(text, { bom: true, trim: true, relax_column_count: true });
  } catch (error) {
    if (!(error instanceof CsvError)) throw error;
    return { products: [], errors: [fileError('import_csv_malformed')], rowCount: 0 };
  }

  // --- The header -------------------------------------------------------------------------------
  const header = (records[0] ?? []).map((cell) => cell.toLowerCase());
  const known = new Set<string>([
    ...PRODUCT_IMPORT_COLUMNS,
    ...lookups.fields.map((field) => `${CUSTOM_FIELD_COLUMN_PREFIX}${field.key}`),
  ]);
  const errors: ProductImportError[] = [];
  for (const column of header) {
    if (column !== '' && !known.has(column)) {
      errors.push({ row: 1, column, code: 'import_column_unknown', params: { column } });
    }
  }
  for (const column of PRODUCT_IMPORT_REQUIRED_COLUMNS) {
    if (!header.includes(column)) {
      errors.push({ row: 1, column, code: 'import_column_missing', params: { column } });
    }
  }
  if (errors.length > 0) return { products: [], errors, rowCount: 0 };

  // Row numbers as a spreadsheet shows them: the header is row 1, so record i is row i + 1.
  // A row of empty cells (Excel writes a few at the end) is skipped, keeping the numbers.
  const rows = records.slice(1).flatMap((record, index) => {
    if (record.every((cell) => cell === '')) return [];
    const cells: Cells = {};
    header.forEach((column, position) => {
      if (column !== '') cells[column] = record[position] ?? '';
    });
    return [{ row: index + 2, cells }];
  });
  if (rows.length === 0) return { products: [], errors: [fileError('import_empty')], rowCount: 0 };
  if (rows.length > PRODUCT_IMPORT_MAX_ROWS) {
    return {
      products: [],
      errors: [fileError('import_too_many_rows', { max: PRODUCT_IMPORT_MAX_ROWS })],
      rowCount: rows.length,
    };
  }

  // --- Rows → products: the same code = the same product ------------------------------------------
  const groups = new Map<string, { row: number; cells: Cells }[]>();
  for (const row of rows) {
    const code = row.cells.code ?? '';
    if (code === '') {
      if (OPTION_COLUMNS.some((k) => (row.cells[`option${String(k)}_value`] ?? '') !== '')) {
        errors.push({ row: row.row, column: 'code', code: 'import_options_without_code' });
        continue;
      }
      groups.set(`#${String(row.row)}`, [row]);
      continue;
    }
    const key = code.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const unitByCode = new Map(lookups.units.map((unit) => [unit.code.toLowerCase(), unit.id]));
  const products: ImportedProduct[] = [];
  for (const group of groups.values()) {
    const built = buildProduct(group, lookups, unitByCode);
    errors.push(...built.errors);
    if (built.product) products.push(built.product);
  }
  return { products, errors, rowCount: rows.length };
}

function buildProduct(
  group: readonly { row: number; cells: Cells }[],
  lookups: ImportLookups,
  unitByCode: ReadonlyMap<string, string>,
): { product: ImportedProduct | null; errors: ProductImportError[] } {
  const errors: ProductImportError[] = [];
  const [first, ...rest] = group;
  if (!first) return { product: null, errors };
  const cell = (column: string) => first.cells[column] ?? '';
  const error = (column: string, code: ErrorCode, params?: Record<string, string | number>) => {
    errors.push({ row: first.row, column, code, ...(params && { params }) });
  };

  // The product's own cells: the later rows leave them empty or repeat them
  for (const row of rest) {
    for (const column of PRODUCT_COLUMNS) {
      const value = row.cells[column] ?? '';
      if (value !== '' && value !== cell(column)) {
        errors.push({ row: row.row, column, code: 'import_row_conflict' });
      }
    }
  }

  // A word from a fixed list; '' = the default
  const pick = <T extends string>(column: string, allowed: readonly T[], fallback: T): T => {
    const value = cell(column).toLowerCase();
    if (value === '') return fallback;
    const found = allowed.find((option) => option === value);
    if (found === undefined) error(column, 'import_value_invalid', { allowed: allowed.join(', ') });
    return found ?? fallback;
  };
  const yesNo = (column: string, value: string, fallback: boolean): boolean => {
    const word = value.toLowerCase();
    if (word === '') return fallback;
    if (YES.has(word)) return true;
    if (NO.has(word)) return false;
    error(column, 'import_value_invalid', { allowed: 'yes, no' });
    return fallback;
  };
  // A unit code → its id; '' = none. An unknown code is reported, and the field left empty so the
  // contract does not add a second error for the same cell.
  const unitId = (column: string): string => {
    const code = cell(column);
    if (code === '') return '';
    const id = unitByCode.get(code.toLowerCase());
    if (id === undefined) error(column, 'import_unit_unknown', { value: code });
    return id ?? '';
  };

  const type = pick('type', ['goods', 'service'] as const, 'goods');
  const tracking = pick(
    'tracking',
    ['none', 'batch', 'serial'] as const,
    type === 'service' ? 'none' : lookups.defaultTracking.tracking,
  );
  const hasExpiry = yesNo(
    'expiry',
    cell('expiry'),
    tracking === 'batch' && cell('tracking') === '' ? lookups.defaultTracking.hasExpiry : false,
  );

  // Options: a name in the first row, a value in every row; the values in the order they come
  const options = OPTION_COLUMNS.flatMap((k) => {
    const values = [
      ...new Set(
        group.map((row) => row.cells[`option${String(k)}_value`] ?? '').filter((v) => v !== ''),
      ),
    ];
    const name = cell(`option${String(k)}_name`);
    if (values.length === 0 && name === '') return [];
    return [{ k, name, values }];
  });

  const units = PACK_COLUMNS.flatMap((k) => {
    const prefix = `pack${String(k)}_`;
    const used = ['unit', 'factor', 'barcode'].some((part) => cell(`${prefix}${part}`) !== '');
    if (!used) return [];
    return [
      {
        unitId: unitId(`${prefix}unit`),
        factor: cell(`${prefix}factor`),
        barcode: cell(`${prefix}barcode`),
      },
    ];
  });

  const customFields: Record<string, string | boolean> = {};
  for (const field of lookups.fields) {
    const column = `${CUSTOM_FIELD_COLUMN_PREFIX}${field.key}`;
    const value = cell(column);
    if (field.type === 'boolean') {
      if (value !== '') customFields[field.key] = yesNo(column, value, false);
    } else {
      customFields[field.key] = value;
    }
  }

  const category = cell('category');
  const categoryPath =
    category === '' ? null : category.split(CATEGORY_PATH_SEPARATOR).map((part) => part.trim());
  if (categoryPath?.some((part) => part === '' || part.length > 80)) {
    error('category', 'import_category_invalid');
  }

  const raw = {
    code: cell('code'),
    name: cell('name'),
    type,
    categoryId: '',
    description: cell('description'),
    baseUnitId: unitId('unit'),
    salesUnitId: unitId('sales_unit'),
    purchaseUnitId: unitId('purchase_unit'),
    tracking,
    hasExpiry,
    options: options.map(({ name, values }) => ({ name, values })),
    variants: group.map((row) => ({
      id: null,
      sku: row.cells.sku ?? '',
      optionValues: options.map(({ k }) => row.cells[`option${String(k)}_value`] ?? ''),
      barcode: row.cells.barcode ?? '',
      salePrice: row.cells.sale_price ?? '',
      archived: false,
    })),
    units,
    customFields,
  };

  // The same contract as the form. A cell already reported above (an unknown unit) is empty now,
  // so the contract's "required" for it would say the same thing twice: skipped.
  const parsed = productInputSchema.safeParse(raw, { error: contractErrorMap });
  const rows = group.map((row) => row.row);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const where = columnOf(
        issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
        rows,
      );
      const code = isErrorCode(issue.message) ? issue.message : 'invalid_value';
      if (errors.some((seen) => seen.row === where.row && seen.column === where.column)) continue;
      errors.push({ row: where.row, column: where.column, code });
    }
  }
  // The workspace's own fields too (the contract only sees "some values"), so a row with a wrong
  // unit also says its missing Generic name — every problem of the file in one go, not one per try
  const fields = customFieldsInputSchema(lookups.fields).safeParse(customFields);
  if (!fields.success) {
    for (const issue of fields.error.issues) {
      const key = issue.path[0];
      const column = typeof key === 'string' ? `${CUSTOM_FIELD_COLUMN_PREFIX}${key}` : null;
      const code = isErrorCode(issue.message) ? issue.message : 'invalid_value';
      if (errors.some((seen) => seen.row === first.row && seen.column === column)) continue;
      errors.push({ row: first.row, column, code });
    }
  }
  if (errors.length > 0 || !parsed.success) return { product: null, errors };
  return { product: { input: parsed.data, rows, categoryPath }, errors };
}
