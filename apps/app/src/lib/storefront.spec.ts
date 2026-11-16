import type { StorefrontCategory } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  listingFormSchema,
  plainAmount,
  pricePreview,
  type SaleForm,
  saleFromForm,
  saleToForm,
  siblingPlace,
  startOfDayIn,
  storefrontCategoryOptions,
} from './storefront';

const DHAKA = 'Asia/Dhaka';
const NO_SALE: SaleForm = { kind: 'none', value: '', startsAt: '', endsAt: '' };

describe('startOfDayIn', () => {
  it('is local midnight as an instant', () => {
    expect(startOfDayIn('2026-11-30', DHAKA)).toBe('2026-11-29T18:00:00.000Z');
    expect(startOfDayIn('2026-11-30', 'UTC')).toBe('2026-11-30T00:00:00.000Z');
  });

  it('follows a clock change (London moves to summer time on 29 Mar 2026)', () => {
    expect(startOfDayIn('2026-03-29', 'Europe/London')).toBe('2026-03-29T00:00:00.000Z');
    expect(startOfDayIn('2026-03-30', 'Europe/London')).toBe('2026-03-29T23:00:00.000Z');
  });
});

describe('sale days (decision 34)', () => {
  it('sends Until as the start of the next day, so the last day counts', () => {
    const sale = saleFromForm(
      { kind: 'percent', value: '10', startsAt: '2026-11-20', endsAt: '2026-11-30' },
      DHAKA,
    );
    expect(sale).toEqual({
      kind: 'percent',
      value: '10',
      startsAt: '2026-11-19T18:00:00.000Z',
      endsAt: '2026-11-30T18:00:00.000Z',
    });
  });

  it('reads the same days back', () => {
    const form: SaleForm = { kind: 'amount', value: '20', startsAt: '', endsAt: '2026-11-30' };
    const sale = saleFromForm(form, DHAKA);
    expect(saleToForm(sale, DHAKA)).toEqual(form);
  });

  it('shows the API amount without its trailing zeros', () => {
    expect(
      saleToForm({ kind: 'price', value: '229.5000', startsAt: null, endsAt: null }, DHAKA),
    ).toEqual({ kind: 'price', value: '229.5', startsAt: '', endsAt: '' });
    expect(saleFromForm(NO_SALE, DHAKA)).toBeNull();
  });
});

describe('plainAmount', () => {
  it('drops only the zeros at the end', () => {
    expect(plainAmount('80.0000')).toBe('80');
    expect(plainAmount('80.5000')).toBe('80.5');
    expect(plainAmount('100')).toBe('100');
    expect(plainAmount('')).toBe('');
  });
});

describe('pricePreview', () => {
  const now = new Date('2026-11-16T06:00:00Z');

  it('uses the listing price, else the product price', () => {
    const own = pricePreview('255', '250.0000', NO_SALE, DHAKA, now);
    expect(own.kind === 'priced' && own.regular).toBe('255');
    const product = pricePreview('', '250.0000', NO_SALE, DHAKA, now);
    expect(product.kind === 'priced' && product.regular).toBe('250.0000');
    expect(pricePreview('', null, NO_SALE, DHAKA, now).kind).toBe('none');
  });

  it('says whether the sale is on, later or over', () => {
    const on = pricePreview('255', null, { ...NO_SALE, kind: 'percent', value: '10' }, DHAKA, now);
    expect(on.kind === 'priced' && on.sale).toBe('on');
    const later = pricePreview(
      '255',
      null,
      { kind: 'percent', value: '10', startsAt: '2026-12-01', endsAt: '' },
      DHAKA,
      now,
    );
    expect(later.kind === 'priced' && later.sale).toBe('later');
    const ended = pricePreview(
      '255',
      null,
      { kind: 'percent', value: '10', startsAt: '', endsAt: '2026-11-15' },
      DHAKA,
      now,
    );
    expect(ended.kind === 'priced' && ended.sale).toBe('ended');
  });

  it('leaves out a sale it cannot read yet', () => {
    const typing = pricePreview(
      '255',
      null,
      { ...NO_SALE, kind: 'percent', value: '' },
      DHAKA,
      now,
    );
    expect(typing.kind === 'priced' && typing.sale).toBe('none');
  });
});

describe('listingFormSchema', () => {
  const values = {
    version: 3,
    name: 'Neem Face Wash',
    slug: '',
    packSize: '150 ml',
    categoryId: '0195f0a0-0000-7000-8000-000000000001',
    priceOverride: '',
    sale: NO_SALE,
    badges: [],
    images: [],
    descriptionSections: [],
    seoTitle: '',
    seoDescription: '',
  };

  it('turns the form into the API body', () => {
    const parsed = listingFormSchema(DHAKA).safeParse({
      ...values,
      sale: { kind: 'percent', value: '10', startsAt: '', endsAt: '2026-11-30' },
    });
    expect(parsed.success && parsed.data).toMatchObject({
      slug: 'neem-face-wash',
      priceOverride: null,
      seoTitle: null,
      sale: { kind: 'percent', value: '10', startsAt: null, endsAt: '2026-11-30T18:00:00.000Z' },
    });
  });

  it("puts the sale's errors on the form's boxes", () => {
    const parsed = listingFormSchema(DHAKA).safeParse({
      ...values,
      sale: { kind: 'percent', value: '10', startsAt: '2026-11-30', endsAt: '2026-11-20' },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['sale.endsAt']);
  });
});

describe('categories', () => {
  const at = (id: string, parentId: string | null, position: number, name: string) =>
    ({
      id,
      parentId,
      position,
      name,
      slug: name.toLowerCase(),
      listingCount: 0,
      version: 1,
      updatedAt: '2026-11-16T00:00:00.000Z',
    }) satisfies StorefrontCategory;
  const list = [
    at('b', null, 2, 'Hair'),
    at('a', null, 1, 'Skin'),
    at('c', 'a', 1, 'Face wash'),
    at('d', 'a', 2, 'Sunscreen'),
  ];

  it('keeps the shop order and shows the path', () => {
    expect(storefrontCategoryOptions(list).map((option) => option.label)).toEqual([
      'Skin',
      'Skin › Face wash',
      'Skin › Sunscreen',
      'Hair',
    ]);
    expect(storefrontCategoryOptions(list, 'a').map((option) => option.value)).toEqual(['b']);
  });

  it('knows the first and the last of the siblings', () => {
    const [hair, , faceWash] = list;
    if (!hair || !faceWash) throw new Error('the list has four categories');
    expect(siblingPlace(list, faceWash)).toEqual({ first: true, last: false });
    expect(siblingPlace(list, hair)).toEqual({ first: false, last: true });
  });
});
