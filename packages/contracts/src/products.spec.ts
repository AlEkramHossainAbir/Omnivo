import { describe, expect, it } from 'vitest';

import { customFieldsInputSchema } from './custom-fields.js';
import {
  barcodeSchema,
  hasValidCheckDigit,
  productInputSchema,
  type ProductFormValues,
  variantSku,
} from './products.js';
import { createUnitInputSchema, sameFactor, standardFactor } from './units.js';

const pcs = '01939d1c-0000-7000-8000-000000000001';
const carton = '01939d1c-0000-7000-8000-000000000002';
const dozen = '01939d1c-0000-7000-8000-000000000003';

function variant(optionValues: string[] = [], extra: object = {}) {
  return { id: null, sku: '', optionValues, barcode: '', salePrice: '', archived: false, ...extra };
}

function product(extra: Partial<ProductFormValues> = {}): ProductFormValues {
  return {
    code: '',
    name: 'Basic crew-neck T-shirt',
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: pcs,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'none',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [variant()],
    units: [],
    customFields: {},
    ...extra,
  };
}

// The first problem's path and code — what the form puts under a field
function firstIssue(input: ProductFormValues) {
  const issue = productInputSchema.safeParse(input).error?.issues[0];
  return issue && { path: issue.path.join('.'), message: issue.message };
}

describe('product input', () => {
  it('turns the empty boxes of a simple product into nulls', () => {
    const parsed = productInputSchema.parse(
      product({ variants: [variant([], { salePrice: '450' })] }),
    );
    expect(parsed).toMatchObject({ code: null, categoryId: null, salesUnitId: null });
    expect(parsed.variants[0]).toMatchObject({ sku: null, barcode: null, salePrice: '450' });
  });

  it('gives a simple product exactly one variant, without option values', () => {
    expect(firstIssue(product({ variants: [variant(), variant()] }))).toEqual({
      path: 'variants',
      message: 'product_variants_simple',
    });
    expect(firstIssue(product({ variants: [variant(['M'])] }))).toEqual({
      path: 'variants',
      message: 'product_variants_simple',
    });
  });

  it('takes variants with one value of every option, each combination once', () => {
    const options = [
      { name: 'Size', values: ['S', 'M'] },
      { name: 'Colour', values: ['Navy', 'White'] },
    ];
    expect(
      productInputSchema.safeParse(
        product({ options, variants: [variant(['S', 'Navy']), variant(['M', 'White'])] }),
      ).success,
    ).toBe(true);
    expect(firstIssue(product({ options, variants: [variant(['S'])] }))).toEqual({
      path: 'variants.0.optionValues',
      message: 'product_variant_values',
    });
    expect(firstIssue(product({ options, variants: [variant(['XL', 'Navy'])] }))).toEqual({
      path: 'variants.0.optionValues',
      message: 'product_variant_values',
    });
    expect(
      firstIssue(product({ options, variants: [variant(['S', 'Navy']), variant(['S', 'Navy'])] })),
    ).toEqual({ path: 'variants.1.optionValues', message: 'product_variant_twice' });
  });

  it('refuses an option or a value twice, whatever the case', () => {
    expect(
      firstIssue(
        product({
          options: [
            { name: 'Size', values: ['S'] },
            { name: 'size', values: ['M'] },
          ],
          variants: [variant(['S', 'M'])],
        }),
      ),
    ).toEqual({ path: 'options.1.name', message: 'product_option_twice' });
    expect(
      firstIssue(
        product({ options: [{ name: 'Size', values: ['M', 'm'] }], variants: [variant(['M'])] }),
      ),
    ).toEqual({ path: 'options.0.values.1', message: 'product_option_value_twice' });
  });

  it('keeps one variant active', () => {
    expect(firstIssue(product({ variants: [variant([], { archived: true })] }))).toEqual({
      path: 'variants',
      message: 'product_variant_last_active',
    });
  });

  it('checks the packs and the default units against the base unit', () => {
    const units = [{ unitId: carton, factor: '24', barcode: '' }];
    expect(productInputSchema.safeParse(product({ units, salesUnitId: carton })).success).toBe(
      true,
    );
    expect(firstIssue(product({ units: [{ unitId: pcs, factor: '1', barcode: '' }] }))).toEqual({
      path: 'units.0.unitId',
      message: 'product_unit_is_base',
    });
    expect(firstIssue(product({ units: [...units, ...units] }))).toEqual({
      path: 'units.1.unitId',
      message: 'product_unit_twice',
    });
    expect(firstIssue(product({ units, purchaseUnitId: dozen }))).toEqual({
      path: 'purchaseUnitId',
      message: 'product_default_unit_invalid',
    });
    expect(firstIssue(product({ units: [{ unitId: carton, factor: '0', barcode: '' }] }))).toEqual({
      path: 'units.0.factor',
      message: 'factor_format',
    });
  });

  it('keeps services untracked and expiry dates on batches', () => {
    expect(firstIssue(product({ type: 'service', tracking: 'batch' }))).toEqual({
      path: 'tracking',
      message: 'product_tracking_service',
    });
    expect(firstIssue(product({ tracking: 'serial', hasExpiry: true }))).toEqual({
      path: 'hasExpiry',
      message: 'product_expiry_needs_batch',
    });
  });

  it('finds a barcode or a SKU used twice in one product', () => {
    const options = [{ name: 'Size', values: ['S', 'M'] }];
    expect(
      firstIssue(
        product({
          options,
          variants: [
            variant(['S'], { barcode: '8901234567890' }),
            variant(['M'], { barcode: '8901234567890' }),
          ],
        }),
      ),
    ).toEqual({ path: 'variants.1.barcode', message: 'barcode_twice' });
    expect(
      firstIssue(
        product({
          options,
          variants: [variant(['S'], { sku: 'ST-1' }), variant(['M'], { sku: 'st-1' })],
        }),
      ),
    ).toEqual({ path: 'variants.1.sku', message: 'product_sku_twice' });
  });

  it('keeps pack barcodes to products without variants', () => {
    expect(
      firstIssue(
        product({
          options: [{ name: 'Size', values: ['M'] }],
          variants: [variant(['M'])],
          units: [{ unitId: carton, factor: '24', barcode: '18901234567897' }],
        }),
      ),
    ).toEqual({ path: 'units.0.barcode', message: 'product_pack_barcode_variants' });
  });
});

describe('barcodes', () => {
  it('checks the check digit of retail barcodes only', () => {
    expect(hasValidCheckDigit('8941100500118')).toBe(true);
    expect(barcodeSchema.safeParse('8941100500118').success).toBe(true);
    // One digit typed wrong
    expect(barcodeSchema.safeParse('8941100500128').error?.issues[0]?.message).toBe(
      'barcode_check_digit',
    );
    // EAN-8 and UPC-A
    expect(barcodeSchema.safeParse('96385074').success).toBe(true);
    expect(barcodeSchema.safeParse('036000291452').success).toBe(true);
    // A store's own code is not a retail barcode: no check digit to check
    expect(barcodeSchema.safeParse('ST-118-M').success).toBe(true);
    expect(barcodeSchema.safeParse('has space').error?.issues[0]?.message).toBe('barcode_format');
  });
});

describe('variantSku', () => {
  it('joins the code and the values, as a code may be written', () => {
    expect(variantSku('ST-118', ['M', 'Navy blue'])).toBe('ST-118-M-NAVY-BLUE');
    expect(variantSku('ST-118', ['Black & white'])).toBe('ST-118-BLACK-WHITE');
    expect(variantSku('P-00042', [])).toBe('P-00042');
  });
});

describe('units', () => {
  const unit = (dimension: string, ratio: string | null) => ({ dimension, ratio });

  it('converts within a dimension, rounded to 6 places', () => {
    expect(standardFactor(unit('length', '0.914400'), unit('length', '1'))).toBe('0.914400');
    expect(standardFactor(unit('length', '1'), unit('length', '0.9144'))).toBe('1.093613');
    expect(standardFactor(unit('count', '12'), unit('count', '1'))).toBe('12.000000');
    expect(standardFactor(unit('weight', '1'), unit('weight', '0.001'))).toBe('1000.000000');
  });

  it('has no standard answer for packs or across dimensions', () => {
    expect(standardFactor(unit('count', null), unit('count', '1'))).toBeNull();
    expect(standardFactor(unit('weight', '1'), unit('count', '1'))).toBeNull();
  });

  it('compares factors as numbers', () => {
    expect(sameFactor('12', '12.000000')).toBe(true);
    expect(sameFactor('0.5', '0.50001')).toBe(false);
  });

  it('takes an empty ratio as a pack', () => {
    expect(
      createUnitInputSchema.parse({
        code: 'box',
        name: 'Box',
        dimension: 'count',
        ratio: '',
        decimals: 0,
      }).ratio,
    ).toBeNull();
    expect(
      createUnitInputSchema.safeParse({
        code: 'sq ft',
        name: 'Square foot',
        dimension: 'area',
        ratio: '0.092903',
        decimals: 2,
      }).error?.issues[0]?.message,
    ).toBe('unit_code_format');
  });
});

describe('custom field values', () => {
  const schema = customFieldsInputSchema([
    { key: 'generic_name', type: 'text', options: [], required: true },
    { key: 'gsm', type: 'number', options: [], required: false },
    { key: 'dosage_form', type: 'select', options: ['Tablet', 'Syrup'], required: false },
    { key: 'expiry_on_pack', type: 'boolean', options: [], required: false },
    { key: 'registered', type: 'date', options: [], required: false },
  ]);

  it('drops empty values and keeps the rest as they are', () => {
    expect(
      schema.parse({
        generic_name: ' Paracetamol ',
        gsm: '',
        dosage_form: 'Tablet',
        expiry_on_pack: true,
        registered: '',
      }),
    ).toEqual({ generic_name: 'Paracetamol', dosage_form: 'Tablet', expiry_on_pack: true });
  });

  it('says what is wrong with each value', () => {
    const issues = schema.safeParse({
      generic_name: '',
      gsm: '180 g',
      dosage_form: 'Capsule',
      registered: '2026-02-30',
    }).error?.issues;
    expect(issues?.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['generic_name', 'required'],
      ['gsm', 'number_format'],
      ['dosage_form', 'invalid_value'],
      ['registered', 'invalid_format'],
    ]);
  });

  it('refuses a field the workspace does not have', () => {
    expect(
      schema.safeParse({ generic_name: 'Paracetamol', fabric: 'Cotton' }).error?.issues[0]?.message,
    ).toBe('custom_field_unknown');
  });
});
