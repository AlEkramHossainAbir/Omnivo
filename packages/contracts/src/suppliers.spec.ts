import { describe, expect, it } from 'vitest';

import { partyRoleOf } from './accounts.js';
import { defaultNumberFormat, formatDocumentNumber } from './numbering.js';
import { type SupplierFormValues, supplierInputSchema } from './suppliers.js';

function supplier(extra: Partial<SupplierFormValues> = {}): SupplierFormValues {
  return {
    code: '',
    name: 'Karim Fabrics Ltd.',
    groupId: '',
    contactPerson: '',
    phone: '01811-000000',
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 45,
    address: '',
    bankAccounts: [],
    notes: '',
    ...extra,
  };
}

const bankAccount = {
  id: null,
  bankName: 'Dutch-Bangla Bank',
  branchName: 'Motijheel',
  accountName: 'Karim Fabrics Ltd.',
  accountNumber: '',
  routingNumber: '',
};

describe('supplier input', () => {
  it('reads empty boxes as "not set": no code, no group, no address', () => {
    expect(supplierInputSchema.parse(supplier())).toMatchObject({
      code: null,
      groupId: null,
      email: null,
      bin: null,
      address: null,
    });
  });

  it('cleans an account number typed with spaces and hyphens, and keeps an empty routing as null', () => {
    const parsed = supplierInputSchema.parse(
      supplier({ bankAccounts: [{ ...bankAccount, accountNumber: '0123-4567 890-01' }] }),
    );
    expect(parsed.bankAccounts[0]).toMatchObject({
      accountNumber: '0123456789001',
      routingNumber: null,
    });
  });

  it('refuses a short account number and a routing number that is not 9 digits, on each box', () => {
    const result = supplierInputSchema.safeParse(
      supplier({
        bankAccounts: [{ ...bankAccount, accountNumber: '12345', routingNumber: '0901234' }],
      }),
    );
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['bankAccounts', 0, 'accountNumber'],
        message: 'bank_account_number_format',
      }),
      expect.objectContaining({
        path: ['bankAccounts', 0, 'routingNumber'],
        message: 'routing_number_format',
      }),
    ]);
  });

  it('holds at most five bank accounts', () => {
    const account = { ...bankAccount, accountNumber: '1234567890' };
    expect(
      supplierInputSchema.safeParse(
        supplier({ bankAccounts: Array.from({ length: 6 }, () => account) }),
      ).success,
    ).toBe(false);
  });

  it('gives a supplier its own code series, a code for good like a customer', () => {
    expect(formatDocumentNumber(defaultNumberFormat('purchase.supplier'), '', 42)).toBe('S-00042');
    expect(defaultNumberFormat('purchase.requisition')).toMatchObject({
      prefix: 'PR',
      yearStyle: 'fiscal',
    });
  });
});

describe('partyRoleOf', () => {
  it('names a customer on the receivable, a supplier on the payable, nobody elsewhere', () => {
    expect(partyRoleOf('accounts_receivable')).toBe('customer');
    expect(partyRoleOf('accounts_payable')).toBe('supplier');
    expect(partyRoleOf('cash')).toBeNull();
    expect(partyRoleOf(null)).toBeNull();
  });
});
