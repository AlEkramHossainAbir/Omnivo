import {
  type CreditNoteReason,
  type LanguageCode,
  type OutputDocument,
  type PaymentMethod,
  SHARE_LINK_DAYS,
} from '@omnivo/contracts';

// Every word a customer reads in step 16, in both languages side by side: the PDF, the email's
// first subject and message, the lines the server adds under the message, and the WhatsApp text.
// The server writes them (decision 12), so a person whose screen is in English can send a Bangla
// invoice. The PDF's words are the browser print's (print.* in en.ts/bn.ts), so paper and PDF say
// the same thing. satisfies: a text missing in one language does not compile.

// What the email and WhatsApp sentences need to know about the document
export interface DocumentFacts {
  kind: OutputDocument;
  title: string;
  number: string;
  // "৳1,15,000.00", in the language's digits
  amount: string;
  // The quotation's "valid until" or the invoice's due date, already formatted; else null
  date: string | null;
  // A credit note's invoice number; else null
  invoice: string | null;
}

export interface DocumentCopy {
  titles: Record<OutputDocument, string>;
  bin: (bin: string) => string;
  phone: (phone: string) => string;
  number: string;
  date: string;
  validUntil: string;
  dueDate: string;
  customerReference: string;
  order: string;
  originalInvoice: string;
  invoiceDate: string;
  reason: string;
  customer: string;
  billTo: string;
  receivedFrom: string;
  columns: {
    number: string;
    item: string;
    quantity: string;
    price: string;
    discount: string;
    vat: string;
    amount: string;
  };
  batch: (lot: string) => string;
  expires: (date: string) => string;
  serials: (serials: string) => string;
  fromChallan: (number: string) => string;
  fromReturn: (number: string) => string;
  lineDiscounts: string;
  net: string;
  vat: string;
  total: string;
  pricesWithVat: string;
  pricesWithoutVat: string;
  paid: string;
  credited: string;
  due: string;
  amountReceived: string;
  paidBy: string;
  reference: string;
  allocationColumns: { invoice: string; date: string; total: string; amount: string };
  advance: string;
  methods: Record<PaymentMethod, string>;
  reasons: Record<CreditNoteReason, string>;
  note: string;
  inWords: (words: string) => string;
  signatures: { customer: string; receivedBy: string; preparedBy: string; authorised: string };
  page: (page: string, pages: string) => string;
  // The email dialog's first values; the person can change both
  emailSubject: (facts: DocumentFacts, company: string) => string;
  emailMessage: (facts: DocumentFacts, customer: string, sender: string, company: string) => string;
  // The lines the server puts under the person's message. They are not editable: they say what is
  // attached and who really sent it, which the customer must be able to trust.
  emailAttached: (fileName: string) => string;
  emailSentBy: (sender: string, company: string) => string;
  emailReply: (company: string) => string;
  // The WhatsApp text with the link in it
  shareMessage: (facts: DocumentFacts, company: string, url: string) => string;
}

const bnDigits = new Intl.NumberFormat('bn-BD');

export const DOCUMENT_COPY = {
  en: {
    titles: {
      quotation: 'Quotation',
      invoice: 'Invoice',
      receipt: 'Money receipt',
      credit_note: 'Credit note',
    },
    bin: (bin) => `BIN ${bin}`,
    phone: (phone) => `Phone ${phone}`,
    number: 'No.',
    date: 'Date',
    validUntil: 'Valid until',
    dueDate: 'Due date',
    customerReference: 'Your reference',
    order: 'Order',
    originalInvoice: 'Original invoice',
    invoiceDate: 'Invoice date',
    reason: 'Reason',
    customer: 'Customer',
    billTo: 'Bill to',
    receivedFrom: 'Received from',
    columns: {
      number: '#',
      item: 'Item',
      quantity: 'Quantity',
      price: 'Price',
      discount: 'Discount',
      vat: 'VAT',
      amount: 'Amount',
    },
    batch: (lot) => `Batch ${lot}`,
    expires: (date) => `expires ${date}`,
    serials: (serials) => `Serial numbers: ${serials}`,
    fromChallan: (number) => `From ${number}`,
    fromReturn: (number) => `Goods back on ${number}`,
    lineDiscounts: 'Line discounts',
    net: 'Before VAT',
    vat: 'VAT',
    total: 'Total',
    pricesWithVat: 'Prices include VAT',
    pricesWithoutVat: 'Prices do not include VAT',
    paid: 'Paid',
    credited: 'Credited',
    due: 'Still due',
    amountReceived: 'Amount received',
    paidBy: 'Paid by',
    reference: 'Reference',
    allocationColumns: { invoice: 'Invoice', date: 'Date', total: 'Total', amount: 'Applied' },
    advance: 'Kept as an advance',
    methods: {
      cash: 'Cash',
      bank_transfer: 'Bank transfer',
      cheque: 'Cheque',
      mobile_wallet: 'Mobile wallet',
      card: 'Card',
    },
    reasons: {
      goods_returned: 'Goods came back',
      price_adjustment: 'Price cut',
      billing_error: 'Billing mistake',
      other: 'Other',
    },
    note: 'Note',
    inWords: (words) => `In words: ${words}`,
    signatures: {
      customer: 'Customer’s signature',
      receivedBy: 'Received by',
      preparedBy: 'Prepared by',
      authorised: 'Authorised signature',
    },
    page: (page, pages) => `Page ${page} of ${pages}`,
    emailSubject: (facts, company) => `${facts.title} ${facts.number} from ${company}`,
    emailMessage: (facts, customer, sender, company) => {
      const lead = {
        quotation:
          facts.date === null
            ? `Please find attached our quotation ${facts.number} for ${facts.amount}.`
            : `Please find attached our quotation ${facts.number} for ${facts.amount}, valid until ${facts.date}.`,
        invoice: `Please find attached invoice ${facts.number} for ${facts.amount}, due on ${facts.date ?? ''}.`,
        receipt: `Thank you for your payment. Please find attached money receipt ${facts.number} for ${facts.amount}.`,
        credit_note: `Please find attached credit note ${facts.number} for ${facts.amount}, against invoice ${facts.invoice ?? ''}.`,
      } satisfies Record<OutputDocument, string>;
      return `Dear ${customer},\n\n${lead[facts.kind]}\n\nRegards,\n${sender}\n${company}`;
    },
    emailAttached: (fileName) => `Attached: ${fileName}`,
    emailSentBy: (sender, company) => `${sender} sent this from ${company} using Omnivo.`,
    // The name is not last: "Ltd." would end the sentence with two full stops
    emailReply: (company) => `To reach ${company}, reply to this email.`,
    shareMessage: (facts, company, url) =>
      `${company}: ${facts.title} ${facts.number} for ${facts.amount}.\n` +
      `Open or download the PDF: ${url}\n` +
      `The link works for ${String(SHARE_LINK_DAYS)} days.`,
  },
  bn: {
    titles: {
      quotation: 'কোটেশন',
      invoice: 'ইনভয়েস',
      receipt: 'মানি রিসিট',
      credit_note: 'ক্রেডিট নোট',
    },
    bin: (bin) => `BIN ${bin}`,
    phone: (phone) => `ফোন ${phone}`,
    number: 'নং',
    date: 'তারিখ',
    validUntil: 'যে তারিখ পর্যন্ত',
    dueDate: 'পরিশোধের তারিখ',
    customerReference: 'আপনার রেফারেন্স',
    order: 'অর্ডার',
    originalInvoice: 'মূল ইনভয়েস',
    invoiceDate: 'ইনভয়েসের তারিখ',
    reason: 'কারণ',
    customer: 'গ্রাহক',
    billTo: 'বিলের ঠিকানা',
    receivedFrom: 'যার কাছ থেকে পাওয়া গেছে',
    columns: {
      number: '#',
      item: 'আইটেম',
      quantity: 'পরিমাণ',
      price: 'দাম',
      discount: 'ছাড়',
      vat: 'VAT',
      amount: 'টাকা',
    },
    batch: (lot) => `ব্যাচ ${lot}`,
    expires: (date) => `মেয়াদ ${date}`,
    serials: (serials) => `সিরিয়াল নম্বর: ${serials}`,
    fromChallan: (number) => `${number} থেকে`,
    fromReturn: (number) => `${number}-এ ফেরত আসা মাল`,
    lineDiscounts: 'লাইনের ছাড়',
    net: 'VAT-এর আগে',
    vat: 'VAT',
    total: 'মোট',
    pricesWithVat: 'দামে VAT ধরা',
    pricesWithoutVat: 'দাম VAT ছাড়া',
    paid: 'পরিশোধিত',
    credited: 'ক্রেডিট হয়েছে',
    due: 'বাকি',
    amountReceived: 'পাওয়া টাকা',
    paidBy: 'যেভাবে দিয়েছেন',
    reference: 'রেফারেন্স',
    allocationColumns: { invoice: 'ইনভয়েস', date: 'তারিখ', total: 'মোট', amount: 'ধরা হলো' },
    advance: 'অগ্রিম হিসেবে রাখা',
    methods: {
      cash: 'নগদ',
      bank_transfer: 'ব্যাংক ট্রান্সফার',
      cheque: 'চেক',
      mobile_wallet: 'মোবাইল ওয়ালেট',
      card: 'কার্ড',
    },
    reasons: {
      goods_returned: 'মাল ফেরত এসেছে',
      price_adjustment: 'দাম কমানো',
      billing_error: 'বিলের ভুল',
      other: 'অন্য কারণ',
    },
    note: 'নোট',
    inWords: (words) => `কথায়: ${words}`,
    signatures: {
      customer: 'গ্রাহকের স্বাক্ষর',
      receivedBy: 'গ্রহণকারী',
      preparedBy: 'প্রস্তুতকারী',
      authorised: 'অনুমোদিত স্বাক্ষর',
    },
    page: (page, pages) => `পৃষ্ঠা ${page} / ${pages}`,
    emailSubject: (facts, company) => `${company} থেকে ${facts.title} ${facts.number}`,
    emailMessage: (facts, customer, sender, company) => {
      const lead = {
        quotation:
          facts.date === null
            ? `আমাদের কোটেশন ${facts.number} (${facts.amount}) সংযুক্ত করা হলো।`
            : `আমাদের কোটেশন ${facts.number} (${facts.amount}) সংযুক্ত করা হলো। এটা ${facts.date} পর্যন্ত বহাল।`,
        invoice: `ইনভয়েস ${facts.number} (${facts.amount}) সংযুক্ত করা হলো। পরিশোধের তারিখ ${facts.date ?? ''}।`,
        receipt: `আপনার পেমেন্টের জন্য ধন্যবাদ। মানি রিসিট ${facts.number} (${facts.amount}) সংযুক্ত করা হলো।`,
        credit_note: `ইনভয়েস ${facts.invoice ?? ''}-এর বিপরীতে ক্রেডিট নোট ${facts.number} (${facts.amount}) সংযুক্ত করা হলো।`,
      } satisfies Record<OutputDocument, string>;
      return `প্রিয় ${customer},\n\n${lead[facts.kind]}\n\nধন্যবাদান্তে,\n${sender}\n${company}`;
    },
    emailAttached: (fileName) => `সংযুক্ত: ${fileName}`,
    emailSentBy: (sender, company) => `${sender} এটা ${company} থেকে Omnivo দিয়ে পাঠিয়েছেন।`,
    emailReply: (company) => `${company}-এর সাথে যোগাযোগ করতে এই ইমেইলের উত্তর দিন।`,
    shareMessage: (facts, company, url) =>
      `${company}: ${facts.title} ${facts.number}, ${facts.amount}।\n` +
      `PDF দেখুন বা নামান: ${url}\n` +
      `লিংকটা ${bnDigits.format(SHARE_LINK_DAYS)} দিন কাজ করবে।`,
  },
} satisfies Record<LanguageCode, DocumentCopy>;
