import type { AccountType, LanguageCode, ReportKind } from '@omnivo/contracts';

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
}

export const COPY = {
  en: {
    titles: {
      trial_balance: 'Trial balance',
      profit_and_loss: 'Profit and loss',
      balance_sheet: 'Balance sheet',
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
  },
  bn: {
    titles: {
      trial_balance: 'ট্রায়াল ব্যালান্স',
      profit_and_loss: 'লাভ-ক্ষতির হিসাব',
      balance_sheet: 'ব্যালান্স শিট',
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
  },
} satisfies Record<LanguageCode, Copy>;
