import { addMoney, fiscalYearOf, shiftIsoDate, todayIn } from '@omnivo/contracts';

import { saveBill, savePayment, submitBill, submitPayment } from './bill-data';
import { createReceipt, postInvoice, saveInvoice } from './invoice-data';
import { createSale } from './pos-data';
import { postDebitNote, saveDebitNote } from './purchase-return-data';
import { postCreditNote, saveCreditNote } from './return-data';
import type { WorkspaceData } from './workspace-data';

// Step 21b: a year of trade for the sales and purchase reports and the agings, in the garments
// workspace. Real documents, made by the mock's own functions, so a party's page links to an invoice
// that opens, and the books agree with the reports.
//
// Everything but the last two documents is dated by the LAST fiscal year's end, never by today: the
// e2e tests read that year ("Last fiscal year", and an aging as of its last day), so their numbers
// are the same on whatever day they run. As of that day (E):
//
//   Customers    H&M      invoice 30,000 less a 2,000 credit note less 18,000 of a 20,000 receipt
//                         = 10,000 open, 70 days late (61–90), 2,000 in advance
//                Primark  25,000 open, 10 days late (1–30)
//                Aarong    5,000 open, not due yet
//                Bengal    8,000 open, 170 days late (90+)
//   Suppliers    Meghna   bill 11,000 less a 500 debit note less 5,500 of a 6,000 payment
//                         = 5,000 open, 60 days late (31–60), 500 in advance
//                Gazipur Carton 6,000 open, not due yet
//
//   Sold 71,000, taken back 2,000, net 69,000, cost 52,800. Bought 17,000, taken back 500, net 16,500.
//
// The last two documents are dated today, so a person in `pnpm dev:mock` sees numbers on the pages'
// first view ("This month", as of today).
export function seedTradeHistory(data: WorkspaceData): void {
  const product = (code: string) => data.catalog.products.find((item) => item.code === code);
  const customer = (name: string) =>
    data.sales.customers.find((item) => item.name.startsWith(name));
  const supplier = (name: string) =>
    data.suppliers.suppliers.find((item) => item.name.startsWith(name));
  const account = (code: string) => data.accounts.find((item) => item.code === code);
  const branch = (code: string) => data.branches.find((item) => item.code === code);
  const [main] = data.stock.warehouses;
  const exempt = data.sales.taxRates.find((rate) => rate.name === 'Exempt');
  const hm = customer('H&M');
  const primark = customer('Primark');
  const aarong = customer('Aarong');
  const bengal = customer('Bengal');
  const meghna = supplier('Meghna');
  const carton = supplier('Gazipur Carton');
  const polo = product('ST-118');
  const tee = product('P-00001');
  const buttons = product('P-00003');
  const mailers = product('P-00004');
  const cash = account('1110');
  const transport = account('5170');
  const head = branch('HO');
  const factory = branch('GZP');
  const counter = data.pos.registers.find((item) => item.code === 'POS2');
  if (
    !main ||
    !exempt ||
    !hm ||
    !primark ||
    !aarong ||
    !bengal ||
    !meghna ||
    !carton ||
    !polo ||
    !tee ||
    !buttons ||
    !mailers ||
    !cash ||
    !transport ||
    !head ||
    !factory ||
    !counter?.deviceId
  ) {
    return;
  }

  const today = todayIn(data.settings.timezone);
  const startMonth = data.settings.fiscalYearStartMonth;
  // The day before this year's first day is in the year before it, on any day of the year
  const lastYearEnd = shiftIsoDate(fiscalYearOf(today, startMonth).start, -1);
  const before = (days: number) => shiftIsoDate(lastYearEnd, -days);

  const priceless = {
    description: null,
    discountType: 'percent',
    discount: '0',
  } as const;

  const invoice = (
    who: { id: string },
    goods: { variants: { id: string }[]; baseUnitId: string },
    quantity: string,
    unitPrice: string,
    date: string,
    dueDate: string,
    branchId: string,
  ) => {
    const draft = saveInvoice(data, {
      customerId: who.id,
      date,
      note: null,
      dueDate,
      customerReference: null,
      branchId,
      warehouseId: main.id,
      lines: [
        {
          ...priceless,
          variantId: goods.variants[0]?.id ?? '',
          unitId: goods.baseUnitId,
          quantity,
          unitPrice,
          taxRateId: exempt.id,
          deliveryLineId: null,
          orderLineId: null,
          batchId: null,
          serialNumbers: [],
        },
      ],
    });
    // Over a limit or not, an old sale is already made
    postInvoice(data, draft, true);
    return draft;
  };

  const bill = (
    who: { id: string },
    goods: { variants: { id: string }[]; baseUnitId: string },
    quantity: string,
    unitPrice: string,
    date: string,
    dueDate: string,
    expenses: { accountId: string; description: string; amount: string; taxRateId: string }[],
    supplierBillNumber: string,
  ) => {
    const saved = saveBill(data, {
      supplierId: who.id,
      date,
      dueDate,
      supplierBillNumber,
      mushakNumber: null,
      mushakDate: null,
      branchId: head.id,
      warehouseId: main.id,
      pricesIncludeVat: false,
      note: null,
      lines: [
        {
          ...priceless,
          variantId: goods.variants[0]?.id ?? '',
          unitId: goods.baseUnitId,
          quantity,
          unitPrice,
          taxRateId: exempt.id,
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

  // ---- Sales ----
  const hmInvoice = invoice(hm, polo, '60', '500', before(100), before(70), factory.id);
  invoice(primark, tee, '100', '250', before(40), before(10), head.id);
  invoice(aarong, buttons, '1000', '5', before(20), shiftIsoDate(lastYearEnd, 10), head.id);
  invoice(bengal, tee, '40', '200', before(200), before(170), head.id);

  // A price cut: money back, no goods, so the quantity and the cost stay
  const [hmLine] = hmInvoice.lines;
  if (hmLine) {
    postCreditNote(
      data,
      saveCreditNote(data, {
        invoiceId: hmInvoice.id,
        date: before(60),
        reason: 'price_adjustment',
        note: null,
        lines: [
          {
            ...priceless,
            invoiceLineId: hmLine.id,
            returnLineId: null,
            unitId: hmLine.unitId,
            quantity: '4',
            unitPrice: '500',
          },
        ],
      }),
    );
  }

  createReceipt(data, {
    customerId: hm.id,
    date: before(30),
    amount: '20000',
    accountId: cash.id,
    method: 'cash',
    reference: null,
    branchId: factory.id,
    note: null,
    allocations: [{ invoiceId: hmInvoice.id, amount: '18000' }],
  });

  // A walk-in at the counter
  createSale(data, counter.deviceId, crypto.randomUUID(), {
    registerId: counter.id,
    sequence: 215,
    shiftId: null,
    date: before(5),
    soldAt: `${before(5)}T05:00:00.000Z`,
    customerId: null,
    pricesIncludeVat: false,
    billDiscountType: 'percent',
    billDiscount: '0',
    payments: [{ method: 'cash', amount: '3000', reference: null, returnId: null }],
    lines: [
      {
        ...priceless,
        id: null,
        variantId: tee.variants[0]?.id ?? '',
        unitId: tee.baseUnitId,
        quantity: '10',
        unitPrice: '300',
        taxRateId: exempt.id,
        rate: '0.00',
        startingPrice: null,
        batchId: null,
        serialNumbers: [],
      },
    ],
  });

  // ---- Purchases ----
  const meghnaBill = bill(
    meghna,
    buttons,
    '2000',
    '5',
    before(90),
    before(60),
    [
      {
        accountId: transport.id,
        description: 'Truck rent, Narsingdi to the Main store',
        amount: '1000',
        taxRateId: exempt.id,
      },
    ],
    'MSM-2026-1104',
  );
  bill(
    carton,
    mailers,
    '1000',
    '6',
    before(20),
    shiftIsoDate(lastYearEnd, 10),
    [],
    'GCI-2026-0277',
  );

  const [meghnaLine] = meghnaBill.lines;
  if (meghnaLine) {
    postDebitNote(
      data,
      saveDebitNote(data, {
        supplierId: meghna.id,
        billId: meghnaBill.id,
        date: before(40),
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

  submitPayment(
    data,
    savePayment(data, {
      supplierId: meghna.id,
      date: before(30),
      amount: addMoney('5500', '500'),
      accountId: cash.id,
      method: 'cash',
      reference: null,
      supplierBankAccountId: null,
      branchId: head.id,
      orderId: null,
      note: null,
      allocations: [{ billId: meghnaBill.id, amount: '5500' }],
    }),
  );

  // ---- Today, for the pages' first view ----
  invoice(primark, tee, '10', '320', today, shiftIsoDate(today, 30), head.id);
  bill(carton, mailers, '500', '6', today, shiftIsoDate(today, 30), [], 'GCI-2026-0301');
}
