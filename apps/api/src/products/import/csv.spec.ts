import { describe, expect, it } from 'vitest';

import { type ImportLookups, readProductsCsv } from './csv.js';

const pcs = '01939d1c-0000-7000-8000-000000000001';
const box = '01939d1c-0000-7000-8000-000000000002';
const strip = '01939d1c-0000-7000-8000-000000000003';

const lookups: ImportLookups = {
  units: [
    { id: pcs, code: 'pcs' },
    { id: box, code: 'box' },
    { id: strip, code: 'Strip' },
  ],
  fields: [
    { key: 'generic_name', type: 'text', options: [], required: false },
    { key: 'cold_chain', type: 'boolean', options: [], required: false },
  ],
  defaultTracking: { tracking: 'batch', hasExpiry: true },
};

function read(text: string, extra: Partial<ImportLookups> = {}) {
  return readProductsCsv(new TextEncoder().encode(text), { ...lookups, ...extra });
}

describe('reading a product CSV', () => {
  it('makes a simple product per row without a code, with packs and custom fields', () => {
    const file = read(
      [
        'name,unit,sale_price,pack1_unit,pack1_factor,pack2_unit,pack2_factor,sales_unit,cf_generic_name,cf_cold_chain',
        'Napa 500 mg,pcs,1.20,strip,10,box,100,strip,Paracetamol,no',
        'Seclo 20 mg,pcs,7,box,30,,,,Omeprazole,',
      ].join('\n'),
    );
    expect(file.errors).toEqual([]);
    expect(file.rowCount).toBe(2);
    const [napa, seclo] = file.products;
    expect(napa?.input).toMatchObject({
      code: null,
      name: 'Napa 500 mg',
      baseUnitId: pcs,
      salesUnitId: strip,
      // A blank tracking cell takes the business type's default, like the form
      tracking: 'batch',
      hasExpiry: true,
      units: [
        { unitId: strip, factor: '10', barcode: null },
        { unitId: box, factor: '100', barcode: null },
      ],
      customFields: { generic_name: 'Paracetamol', cold_chain: false },
    });
    expect(napa?.input.variants).toMatchObject([{ optionValues: [], salePrice: '1.20' }]);
    expect(seclo?.rows).toEqual([3]);
  });

  it('turns rows with one code into the variants of one product', () => {
    const file = read(
      [
        'code,name,unit,option1_name,option1_value,option2_name,option2_value,sale_price,tracking',
        'ST-118,Polo shirt,pcs,Size,M,Colour,Navy,650,none',
        'ST-118,,,,L,,Navy,650,',
        'ST-118,,,,M,,White,,',
      ].join('\n'),
    );
    expect(file.errors).toEqual([]);
    expect(file.products).toHaveLength(1);
    expect(file.products[0]?.input.options).toEqual([
      { name: 'Size', values: ['M', 'L'] },
      { name: 'Colour', values: ['Navy', 'White'] },
    ]);
    expect(file.products[0]?.input.variants.map((variant) => variant.optionValues)).toEqual([
      ['M', 'Navy'],
      ['L', 'Navy'],
      ['M', 'White'],
    ]);
    expect(file.products[0]?.rows).toEqual([2, 3, 4]);
  });

  it('points at the row and column of every problem, as a spreadsheet numbers them', () => {
    const file = read(
      [
        'name,unit,sale_price,pack1_unit,pack1_factor,type',
        'Napa 500 mg,tablet,1.20,,,',
        'Ace syrup,pcs,abc,box,0,',
        'X,pcs,,,,gadget',
      ].join('\n'),
    );
    expect(file.products).toEqual([]);
    expect(file.errors).toEqual([
      { row: 2, column: 'unit', code: 'import_unit_unknown', params: { value: 'tablet' } },
      { row: 3, column: 'sale_price', code: 'money_format' },
      { row: 3, column: 'pack1_factor', code: 'factor_format' },
      {
        row: 4,
        column: 'type',
        code: 'import_value_invalid',
        params: { allowed: 'goods, service' },
      },
      { row: 4, column: 'name', code: 'product_name_required' },
    ]);
  });

  it('refuses a later row that says something else about the product', () => {
    const file = read(
      [
        'code,name,unit,option1_name,option1_value',
        'ST-118,Polo shirt,pcs,Size,M',
        'ST-118,Polo shirt (new),pcs,,L',
      ].join('\n'),
    );
    expect(file.errors).toEqual([{ row: 3, column: 'name', code: 'import_row_conflict' }]);
  });

  it('needs a code to put variants together', () => {
    const file = read(['name,unit,option1_name,option1_value', 'Polo,pcs,Size,M'].join('\n'));
    expect(file.errors).toEqual([{ row: 2, column: 'code', code: 'import_options_without_code' }]);
  });

  it('checks the header before any row', () => {
    expect(read('name,colour\nPolo,Navy').errors).toEqual([
      { row: 1, column: 'colour', code: 'import_column_unknown', params: { column: 'colour' } },
      { row: 1, column: 'unit', code: 'import_column_missing', params: { column: 'unit' } },
    ]);
    // A custom field the workspace does not have (or has archived) is an unknown column too
    expect(read('name,unit,cf_gsm\nPolo,pcs,180').errors[0]?.code).toBe('import_column_unknown');
  });

  it('reads Excel’s CSV UTF-8 (with a BOM, Bangla, quotes) and refuses other encodings', () => {
    const file = read(
      '\uFEFFname,unit,description\n"নাপা ৫০০, ট্যাবলেট",pcs,"Says ""fever"""\n,,\n',
    );
    expect(file.errors).toEqual([]);
    expect(file.products[0]?.input).toMatchObject({
      name: 'নাপা ৫০০, ট্যাবলেট',
      description: 'Says "fever"',
    });
    // Windows-1252 "CSV": the é is one byte, 0xE9, which is not UTF-8
    const latin = readProductsCsv(new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0xe9]), lookups);
    expect(latin.errors).toEqual([{ row: null, column: null, code: 'import_encoding' }]);
    expect(read('name,unit\n"Napa,pcs').errors[0]?.code).toBe('import_csv_malformed');
    expect(read('name,unit\n').errors[0]?.code).toBe('import_empty');
  });

  it('keeps a category as a path to find or make later', () => {
    const file = read(
      'name,unit,category\nPolo,pcs,Finished garments > Polo shirts\nTee,pcs,A >> B',
    );
    expect(file.products[0]?.categoryPath).toEqual(['Finished garments', 'Polo shirts']);
    expect(file.errors).toEqual([{ row: 3, column: 'category', code: 'import_category_invalid' }]);
  });
});
