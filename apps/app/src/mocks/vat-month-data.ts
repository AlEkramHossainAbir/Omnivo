import { shiftIsoDate, todayIn } from '@omnivo/contracts';

import { saveBill, submitBill } from './bill-data';
import { postInvoice, saveInvoice } from './invoice-data';
import { createSale } from './pos-data';
import { postDebitNote, saveDebitNote } from './purchase-return-data';
import { postCreditNote, saveCreditNote } from './return-data';
import type { WorkspaceData } from './workspace-data';

// Step 21c: last month's documents with VAT, in the garments workspace, for the VAT report. The
// year of trade (trade-history-data.ts) is all Exempt, so it shows no VAT. Real documents, made by
// the mock's own functions, so the books' VAT accounts agree with the report. Last month, because
// the VAT page opens there (decision 60). In that month:
//
//   Output  invoice Primark (Head office)   20 T-shirts × 250 = 5,000 at 15%    VAT 750
//           credit note on it (price cut)    2 × 250 =  −500 at 15%              VAT −75
//           POS sale, walk-in               4 T-shirts × 300 = 1,200 at 15%     VAT 180
//           invoice H&M (Gazipur factory)   10 polos × 500 = 5,000 zero-rated   VAT 0
//           = net 10,700, VAT 855, of which 75 taken back
//   Input   bill Meghna, Mushak 6.3          1,000 buttons × 5 = 5,000 at 15%   VAT 750
//                                            truck rent 1,000 at 15%             VAT 150
//           bill Gazipur Carton, no 6.3      500 mailers × 6 = 3,000 at 15%      VAT 450
//           debit note on Meghna (price cut) 100 × 5 = −500 at 15%               VAT −75
//           = net 8,500, VAT 1,275, of which 75 taken back, 450 with no Mushak 6.3
//   Net VAT 855 − 1,275 = −420: ৳420 to carry forward
export function seedVatMonth(data: WorkspaceData): void {
  const product = (code: string) => data.catalog.products.find((item) => item.code === code);
  const customer = (name: string) =>
    data.sales.customers.find((item) => item.name.startsWith(name));
  const supplier = (name: string) =>
    data.suppliers.suppliers.find((item) => item.name.startsWith(name));
  const rate = (name: string) => data.sales.taxRates.find((item) => item.name === name);
  const branch = (code: string) => data.branches.find((item) => item.code === code);
  const [main] = data.stock.warehouses;
  const standard = rate('VAT 15%');
  const zero = rate('Zero-rated');
  const hm = customer('H&M');
  const primark = customer('Primark');
  const meghna = supplier('Meghna');
  const carton = supplier('Gazipur Carton');
  const polo = product('ST-118');
  const tee = product('P-00001');
  const buttons = product('P-00003');
  const mailers = product('P-00004');
  const transport = data.accounts.find((item) => item.code === '5170');
  const head = branch('HO');
  const factory = branch('GZP');
  const counter = data.pos.registers.find((item) => item.code === 'POS2');
  if (
    !main ||
    !standard ||
    !zero ||
    !hm ||
    !primark ||
    !meghna ||
    !carton ||
    !polo ||
    !tee ||
    !buttons ||
    !mailers ||
    !transport ||
    !head ||
    !factory ||
    !counter?.deviceId
  ) {
    return;
  }

  // Day `day` of last month: the day before this month's first day is in last month
  const lastMonth = shiftIsoDate(`${todayIn(data.settings.timezone).slice(0, 7)}-01`, -1).slice(
    0,
    7,
  );
  const day = (number: number) => `${lastMonth}-${String(number).padStart(2, '0')}`;

  const priceless = { description: null, discountType: 'percent', discount: '0' } as const;
  const variantOf = (goods: { variants: { id: string }[] }) => goods.variants[0]?.id ?? '';

  const invoice = (
    who: { id: string },
    goods: { variants: { id: string }[]; baseUnitId: string },
    quantity: string,
    unitPrice: string,
    taxRateId: string,
    date: string,
    branchId: string,
  ) => {
    const draft = saveInvoice(data, {
      customerId: who.id,
      date,
      note: null,
      dueDate: shiftIsoDate(date, 30),
      customerReference: null,
      branchId,
      warehouseId: main.id,
      lines: [
        {
          ...priceless,
          variantId: variantOf(goods),
          unitId: goods.baseUnitId,
          quantity,
          unitPrice,
          taxRateId,
          deliveryLineId: null,
          orderLineId: null,
          batchId: null,
          serialNumbers: [],
        },
      ],
    });
    postInvoice(data, draft, true);
    return draft;
  };

  const bill = (
    who: { id: string },
    goods: { variants: { id: string }[]; baseUnitId: string },
    quantity: string,
    unitPrice: string,
    date: string,
    expenses: { accountId: string; description: string; amount: string; taxRateId: string }[],
    numbers: { supplierBillNumber: string; mushakNumber: string | null },
  ) => {
    const saved = saveBill(data, {
      supplierId: who.id,
      date,
      dueDate: shiftIsoDate(date, 30),
      supplierBillNumber: numbers.supplierBillNumber,
      mushakNumber: numbers.mushakNumber,
      mushakDate: numbers.mushakNumber === null ? null : date,
      branchId: head.id,
      warehouseId: main.id,
      pricesIncludeVat: false,
      note: null,
      lines: [
        {
          ...priceless,
          variantId: variantOf(goods),
          unitId: goods.baseUnitId,
          quantity,
          unitPrice,
          taxRateId: standard.id,
          receiptLineId: null,
          orderLineId: null,
          accountId: null,
          lotNumber: null,
          expiresOn: null,
          manufacturedOn: null,
          serialNumbers: [],
        },
      ],
      expenses,
    });
    submitBill(data, saved);
    return saved;
  };

  // ---- Output ----
  const primarkInvoice = invoice(primark, tee, '20', '250', standard.id, day(5), head.id);
  invoice(hm, polo, '10', '500', zero.id, day(15), factory.id);

  const [primarkLine] = primarkInvoice.lines;
  if (primarkLine) {
    postCreditNote(
      data,
      saveCreditNote(data, {
        invoiceId: primarkInvoice.id,
        date: day(12),
        reason: 'price_adjustment',
        note: null,
        lines: [
          {
            ...priceless,
            invoiceLineId: primarkLine.id,
            returnLineId: null,
            unitId: primarkLine.unitId,
            quantity: '2',
            unitPrice: '250',
          },
        ],
      }),
    );
  }

  createSale(data, counter.deviceId, crypto.randomUUID(), {
    registerId: counter.id,
    sequence: 180,
    shiftId: null,
    date: day(8),
    soldAt: `${day(8)}T06:00:00.000Z`,
    customerId: null,
    pricesIncludeVat: false,
    billDiscountType: 'percent',
    billDiscount: '0',
    payments: [{ method: 'cash', amount: '1380', reference: null, returnId: null }],
    lines: [
      {
        ...priceless,
        id: null,
        variantId: variantOf(tee),
        unitId: tee.baseUnitId,
        quantity: '4',
        unitPrice: '300',
        taxRateId: standard.id,
        rate: '15.00',
        startingPrice: null,
        batchId: null,
        serialNumbers: [],
      },
    ],
  });

  // ---- Input ----
  const meghnaBill = bill(
    meghna,
    buttons,
    '1000',
    '5',
    day(10),
    [
      {
        accountId: transport.id,
        description: 'Truck rent, Narsingdi to the Main store',
        amount: '1000',
        taxRateId: standard.id,
      },
    ],
    { supplierBillNumber: 'MSM-2026-1180', mushakNumber: 'MSM-6.3-0918' },
  );
  bill(carton, mailers, '500', '6', day(18), [], {
    supplierBillNumber: 'GCI-2026-0290',
    mushakNumber: null,
  });

  const [meghnaLine] = meghnaBill.lines;
  if (meghnaLine) {
    postDebitNote(
      data,
      saveDebitNote(data, {
        supplierId: meghna.id,
        billId: meghnaBill.id,
        date: day(20),
        branchId: null,
        pricesIncludeVat: false,
        reason: 'price_adjustment',
        supplierCreditNumber: null,
        supplierCreditDate: null,
        note: null,
        expenses: [],
        lines: [
          {
            ...priceless,
            billLineId: meghnaLine.id,
            returnLineId: null,
            taxRateId: null,
            unitId: meghnaLine.unitId,
            quantity: '100',
            unitPrice: '5',
          },
        ],
      }),
    );
  }
}
