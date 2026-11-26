import { describe, expect, it } from 'vitest';

import { routes } from './routes.js';
import {
  MAX_PAYOUT_CSV_CHARS,
  MAX_PAYOUT_LINES,
  payoutCsvMapSchema,
  payoutInputSchema,
  payoutMatchInputSchema,
  STEADFAST_PAYOUT_CSV_PRESET,
} from './storefront-payouts.js';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const BANK = '01920000-0000-7000-8000-000000000002';
const PARCEL_A = '01920000-0000-7000-8000-000000000003';
const PARCEL_B = '01920000-0000-7000-8000-000000000004';

function payout(extra: object = {}) {
  return {
    accountId: ACCOUNT,
    date: '2026-11-24',
    bankAccountId: BANK,
    reference: 'SFC-23618228',
    note: '',
    lines: [
      { shipmentId: PARCEL_A, charge: '60' },
      { shipmentId: PARCEL_B, charge: '0' },
    ],
    ...extra,
  };
}

// The error codes where the form will show them: field path → code
function errorsOf(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) {
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.map(String).join('.'), issue.message]),
  );
}

describe('payout input', () => {
  it('takes parcels with their charges, 0 included', () => {
    expect(payoutInputSchema.parse(payout())).toMatchObject({
      reference: 'SFC-23618228',
      note: null,
      lines: [
        { shipmentId: PARCEL_A, charge: '60' },
        { shipmentId: PARCEL_B, charge: '0' },
      ],
    });
  });

  it('names the box of a missing account, bank account or line', () => {
    expect(
      errorsOf(
        payoutInputSchema.safeParse(payout({ accountId: '', bankAccountId: '', lines: [] })),
      ),
    ).toEqual({
      accountId: 'payout_pick_account',
      bankAccountId: 'payout_bank_account_invalid',
      lines: 'payout_lines_required',
    });
  });

  it('needs a charge in each box, in whole paisa', () => {
    const lines = [
      { shipmentId: PARCEL_A, charge: '' },
      { shipmentId: PARCEL_B, charge: '60.505' },
    ];
    expect(errorsOf(payoutInputSchema.safeParse(payout({ lines })))).toEqual({
      'lines.0.charge': 'payout_charge_required',
      'lines.1.charge': 'money_format',
    });
  });

  it('refuses one parcel twice, on the second line', () => {
    const lines = [
      { shipmentId: PARCEL_A, charge: '60' },
      { shipmentId: PARCEL_A, charge: '60' },
    ];
    expect(errorsOf(payoutInputSchema.safeParse(payout({ lines })))).toEqual({
      'lines.1.shipmentId': 'payout_line_twice',
    });
  });

  it('takes at most MAX_PAYOUT_LINES parcels', () => {
    const lines = Array.from({ length: MAX_PAYOUT_LINES + 1 }, (_, index) => ({
      shipmentId: `01920000-0000-7000-8000-${String(index).padStart(12, '0')}`,
      charge: '0',
    }));
    expect(errorsOf(payoutInputSchema.safeParse(payout({ lines })))).toEqual({
      lines: 'payout_too_many_lines',
    });
  });
});

describe('payout CSV', () => {
  it('maps an empty amount column to none, and needs the key column', () => {
    expect(
      payoutCsvMapSchema.parse({
        key: 'tracking_code',
        keyColumn: ' Tracking Code ',
        collectedColumn: '',
        chargeColumn: 'Charge',
      }),
    ).toEqual({
      key: 'tracking_code',
      keyColumn: 'Tracking Code',
      collectedColumn: null,
      chargeColumn: 'Charge',
    });
    expect(
      errorsOf(
        payoutCsvMapSchema.safeParse({
          key: 'invoice',
          keyColumn: '',
          collectedColumn: '',
          chargeColumn: '',
        }),
      ),
    ).toEqual({ keyColumn: 'payout_csv_column_required' });
  });

  it('keeps the Steadfast preset a valid map', () => {
    expect(payoutCsvMapSchema.parse(STEADFAST_PAYOUT_CSV_PRESET)).toEqual(
      STEADFAST_PAYOUT_CSV_PRESET,
    );
  });

  it('refuses an empty file and one over the size limit', () => {
    expect(errorsOf(payoutMatchInputSchema.safeParse({ csv: '', map: null }))).toEqual({
      csv: 'payout_csv_unreadable',
    });
    const csv = 'a'.repeat(MAX_PAYOUT_CSV_CHARS + 1);
    expect(errorsOf(payoutMatchInputSchema.safeParse({ csv, map: null }))).toEqual({
      csv: 'payout_csv_too_big',
    });
  });
});

describe('payout routes', () => {
  it('never put a word where /storefront/payouts/:id would read it as an id', () => {
    // GET /storefront/payouts/setup or …/parcels would reach `get` with that word as the id
    const paths = Object.values(routes.storefrontPayouts).map((route) => route.path);
    const under = paths.filter((path) => path.startsWith('/storefront/payouts/'));
    expect(under.every((path) => path.startsWith('/storefront/payouts/:id'))).toBe(true);
  });

  it('all need storefront.payout.manage', () => {
    for (const route of Object.values(routes.storefrontPayouts)) {
      expect(route.permission).toBe('storefront.payout.manage');
    }
  });
});
