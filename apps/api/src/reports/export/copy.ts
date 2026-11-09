import type {
  AccountType,
  AgingBucket,
  LanguageCode,
  PurchaseReportGroup,
  ReportKind,
  SalesReportGroup,
  TradeReportRowKind,
} from '@omnivo/contracts';

// Every word inside an exported file, in both languages side by side. satisfies: a text missing in
// one language does not compile. Common office terms (ledger, balance) stay as people say them,
// like the app's bn.ts.
export interface Copy {
  titles: Record<ReportKind, string>;
  sections: Record<AccountType, string>;
  totalOf: Record<AccountType, string>;
  code: string;
  account: string;
  openingDebit: string;
  openingCredit: string;
  debit: string;
  credit: string;
  closingDebit: string;
  closingCredit: string;
  total: string;
  netProfit: string;
  profitNotClosed: string;
  liabilitiesAndEquity: string;
  range: (from: string, to: string) => string;
  asOf: (date: string) => string;
  branch: (name: string) => string;
  currency: (code: string) => string;
  generated: (moment: string) => string;
  page: (page: string, pages: string) => string;
  // The date column headers of a comparison: "1 Jul 2026 – 30 Sep 2026"
  column: (from: string, to: string) => string;
  // Step 21b. The first column's header: what a row is
  groups: Record<SalesReportGroup | PurchaseReportGroup, string>;
  // The name of a row that stands for the lines with no such thing (TRADE_REPORT_ROW_KINDS)
  rowKinds: Record<Exclude<TradeReportRowKind, 'item'>, string>;
  quantity: string;
  sales: {
    gross: string;
    returns: string;
    net: string;
    cost: string;
    margin: string;
    marginPercent: string;
  };
  purchases: { gross: string; returns: string; net: string };
  buckets: Record<AgingBucket, string>;
  due: string;
  advances: string;
  balance: string;
  groupedBy: (group: string) => string;
  customerGroup: (name: string) => string;
  supplierGroup: (name: string) => string;
  category: (name: string) => string;
  overdueOnly: string;
  // The books' figure under the heading, for the reader to compare with the total
  inBooks: (amount: string) => string;
}

export const COPY = {
  en: {
    titles: {
      trial_balance: 'Trial balance',
      profit_and_loss: 'Profit and loss',
      balance_sheet: 'Balance sheet',
      sales_report: 'Sales report',
      purchase_report: 'Purchase report',
      ar_aging: 'Receivables aging',
      ap_aging: 'Payables aging',
    },
    sections: {
      asset: 'Assets',
      liability: 'Liabilities',
      equity: 'Equity',
      income: 'Income',
      expense: 'Expenses',
    },
    totalOf: {
      asset: 'Total assets',
      liability: 'Total liabilities',
      equity: 'Total equity',
      income: 'Total income',
      expense: 'Total expenses',
    },
    code: 'Code',
    account: 'Account',
    openingDebit: 'Opening Dr',
    openingCredit: 'Opening Cr',
    debit: 'Debit',
    credit: 'Credit',
    closingDebit: 'Closing Dr',
    closingCredit: 'Closing Cr',
    total: 'Total',
    netProfit: 'Net profit',
    profitNotClosed: 'Profit not yet closed into retained earnings',
    liabilitiesAndEquity: 'Total liabilities and equity',
    range: (from, to) => `${from} – ${to}`,
    asOf: (date) => `As at ${date}`,
    branch: (name) => `Branch: ${name}`,
    currency: (code) => `Amounts in ${code}`,
    generated: (moment) => `Made on ${moment}`,
    page: (page, pages) => `Page ${page} of ${pages}`,
    column: (from, to) => `${from} – ${to}`,
    groups: {
      customer: 'Customer',
      product: 'Product',
      category: 'Category',
      branch: 'Branch',
      month: 'Month',
      supplier: 'Supplier',
      account: 'Expense account',
    },
    rowKinds: {
      walk_in: 'Walk-in customers',
      no_category: 'No category',
      expenses: 'Expenses',
      products: 'Products',
    },
    quantity: 'Quantity',
    sales: {
      gross: 'Sold',
      returns: 'Returns',
      net: 'Net sales',
      cost: 'Cost',
      margin: 'Margin',
      marginPercent: 'Margin %',
    },
    purchases: { gross: 'Billed', returns: 'Debit notes', net: 'Net purchases' },
    buckets: {
      current: 'Current',
      days1To30: '1–30 days',
      days31To60: '31–60 days',
      days61To90: '61–90 days',
      over90: 'Over 90 days',
    },
    due: 'Total due',
    advances: 'Advances',
    balance: 'Balance',
    groupedBy: (group) => `By ${group.toLowerCase()}`,
    customerGroup: (name) => `Customer group: ${name}`,
    supplierGroup: (name) => `Supplier group: ${name}`,
    category: (name) => `Category: ${name}`,
    overdueOnly: 'Overdue only',
    inBooks: (amount) => `In the books: ${amount}`,
  },
  bn: {
    titles: {
      trial_balance: 'ট্রায়াল ব্যালান্স',
      profit_and_loss: 'লাভ-ক্ষতির হিসাব',
      balance_sheet: 'ব্যালান্স শিট',
      sales_report: 'বিক্রির রিপোর্ট',
      purchase_report: 'কেনাকাটার রিপোর্ট',
      ar_aging: 'পাওনার এজিং',
      ap_aging: 'দেনার এজিং',
    },
    sections: {
      asset: 'সম্পদ',
      liability: 'দায়',
      equity: 'মালিকানা স্বত্ব',
      income: 'আয়',
      expense: 'ব্যয়',
    },
    totalOf: {
      asset: 'মোট সম্পদ',
      liability: 'মোট দায়',
      equity: 'মোট মালিকানা স্বত্ব',
      income: 'মোট আয়',
      expense: 'মোট ব্যয়',
    },
    code: 'কোড',
    account: 'অ্যাকাউন্ট',
    openingDebit: 'প্রারম্ভিক ডে.',
    openingCredit: 'প্রারম্ভিক ক্রে.',
    debit: 'ডেবিট',
    credit: 'ক্রেডিট',
    closingDebit: 'সমাপনী ডে.',
    closingCredit: 'সমাপনী ক্রে.',
    total: 'মোট',
    netProfit: 'নিট লাভ',
    profitNotClosed: 'যে লাভ এখনো রিটেইনড আর্নিংসে যায়নি',
    liabilitiesAndEquity: 'মোট দায় ও মালিকানা স্বত্ব',
    range: (from, to) => `${from} – ${to}`,
    asOf: (date) => `${date} তারিখে`,
    branch: (name) => `ব্রাঞ্চ: ${name}`,
    currency: (code) => `অঙ্কগুলো ${code}-এ`,
    generated: (moment) => `তৈরি: ${moment}`,
    page: (page, pages) => `পৃষ্ঠা ${page} / ${pages}`,
    column: (from, to) => `${from} – ${to}`,
    groups: {
      customer: 'গ্রাহক',
      product: 'প্রোডাক্ট',
      category: 'ক্যাটাগরি',
      branch: 'ব্রাঞ্চ',
      month: 'মাস',
      supplier: 'সাপ্লায়ার',
      account: 'খরচের অ্যাকাউন্ট',
    },
    rowKinds: {
      walk_in: 'ওয়াক-ইন গ্রাহক',
      no_category: 'কোনো ক্যাটাগরি নেই',
      expenses: 'খরচ',
      products: 'প্রোডাক্ট',
    },
    quantity: 'পরিমাণ',
    sales: {
      gross: 'বিক্রি',
      returns: 'ফেরত',
      net: 'নিট বিক্রি',
      cost: 'খরচ',
      margin: 'মার্জিন',
      marginPercent: 'মার্জিন %',
    },
    purchases: { gross: 'বিল', returns: 'ডেবিট নোট', net: 'নিট কেনাকাটা' },
    buckets: {
      current: 'সময় পার হয়নি',
      days1To30: '১–৩০ দিন',
      days31To60: '৩১–৬০ দিন',
      days61To90: '৬১–৯০ দিন',
      over90: '৯০ দিনের বেশি',
    },
    due: 'মোট বকেয়া',
    advances: 'অগ্রিম',
    balance: 'ব্যালান্স',
    groupedBy: (group) => `${group} অনুযায়ী`,
    customerGroup: (name) => `গ্রাহক গ্রুপ: ${name}`,
    supplierGroup: (name) => `সাপ্লায়ার গ্রুপ: ${name}`,
    category: (name) => `ক্যাটাগরি: ${name}`,
    overdueOnly: 'শুধু সময় পার',
    inBooks: (amount) => `হিসাবের খাতায়: ${amount}`,
  },
} satisfies Record<LanguageCode, Copy>;
