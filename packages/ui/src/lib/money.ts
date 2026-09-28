// named import: decimal.js-এর .d.ts CommonJS হিসেবে পড়া হয় (package-এ "type": "module" নেই),
// তাই nodenext-এ default import মানে পুরো module object — `new` করা যায় না
import { Decimal } from 'decimal.js';

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

// বাংলা কীবোর্ডে (Avro/Bijoy) টাইপ করা "১২৩" → "123"; কপি-পেস্ট করা "18,42,600"-এর কমা আর ফাঁকা বাদ
export function normalizeMoneyInput(raw: string): string {
  return raw
    .replace(/[০-৯]/g, (digit) => String(BANGLA_DIGITS.indexOf(digit)))
    .replace(/[,\s]/g, '');
}

// টাইপের মাঝপথের অবস্থাও বৈধ: "", "12", "12.", "12.5" — কিন্তু scale-এর বেশি দশমিক না
export function isMoneyDraft(value: string, scale: number): boolean {
  const decimals = scale > 0 ? `(\\.\\d{0,${String(scale)}})?` : '';
  return new RegExp(`^\\d*${decimals}$`).test(value);
}

// ফর্মে যা যায়: "" অথবা ঠিক scale-ঘর দশমিকের string ("1842600.50")।
// Decimal, JS number না: (1.005).toFixed(2) === "1.00" (binary float), আর ২^৫৩-এর বড়
// অঙ্কে number শেষের অঙ্ক হারায়। Decimal-এর ডিফল্ট rounding ROUND_HALF_UP — হিসাবের নিয়ম
export function toCanonicalMoney(draft: string, scale: number): string {
  if (draft === '' || draft === '.') return '';
  return new Decimal(draft).toFixed(scale);
}
