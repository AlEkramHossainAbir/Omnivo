import { formatNumber } from '@omnivo/i18n';
import { useState } from 'react';

import { isMoneyDraft, normalizeMoneyInput, toCanonicalMoney } from '../lib/money.js';
import { Input, type InputProps } from './field.js';

interface MoneyInputProps extends Omit<
  InputProps,
  'value' | 'defaultValue' | 'onChange' | 'type' | 'inputMode' | 'prefix' | 'align'
> {
  // টাকা কখনো number না — string, যেমন DB-র NUMERIC(19,4) আর contracts-এর schema
  value: string;
  onChange: (value: string) => void;
  // দশমিকের ঘর: টাকা ২, unit price চাইলে ৪
  scale?: number;
}

export function MoneyInput({
  value,
  onChange,
  onFocus,
  onBlur,
  scale = 2,
  ...props
}: MoneyInputProps) {
  // null = এখন লেখা হচ্ছে না, তাই গোছানো রূপ দেখাও; string = ইউজার যা টাইপ করছে হুবহু
  const [draft, setDraft] = useState<string | null>(null);

  // টাইপের সময় কমা বসালে cursor লাফিয়ে যেত — তাই গ্রুপিং শুধু focus ছাড়লে।
  // ইনপুটে সবসময় ইংরেজি অঙ্ক (en): বাংলা অঙ্কে সম্পাদনা অনেক কীবোর্ডে ঝামেলার
  const display = draft ?? (value === '' ? '' : formatNumber(value, 'en', scale));

  return (
    <Input
      {...props}
      type="text"
      // ফোনে সংখ্যার কীবোর্ড, দশমিক বিন্দু সহ (system-design §৮.১)
      inputMode="decimal"
      autoComplete="off"
      prefix="৳"
      align="end"
      value={display}
      onFocus={(event) => {
        // সার্ভারের "1842600.5000" (৪ ঘর) এলেও সম্পাদনা শুরু হয় scale-এর রূপে, নইলে
        // isMoneyDraft প্রতিটা কী চাপ আটকে দিত
        setDraft(value === '' ? '' : toCanonicalMoney(value, scale));
        onFocus?.(event);
      }}
      onChange={(event) => {
        const next = normalizeMoneyInput(event.target.value);
        // অবৈধ কী চাপ (অক্ষর, দ্বিতীয় বিন্দু, তৃতীয় দশমিক) চুপচাপ উপেক্ষা — লেখা বদলায় না
        if (!isMoneyDraft(next, scale)) return;
        setDraft(next);
        // প্রতিটা কী চাপে canonical মান ফর্মে: focus-এ থেকেই Enter চাপলে blur হয় না,
        // তখনও "12." না, "12.00" জমা পড়বে
        onChange(toCanonicalMoney(next, scale));
      }}
      onBlur={(event) => {
        setDraft(null);
        onBlur?.(event);
      }}
    />
  );
}
